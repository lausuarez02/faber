// The sandbox CA: a per-machine certificate authority Fabwright uses to terminate TLS for hosts it
// inspects (mocks, secret injection, cassettes). Emulated firmware trusts it the way a real board
// trusts a root CA bundle; the CA never leaves this machine and is never in an export. Leaf certs
// are made on demand per host name (ECDSA P-256, short-lived) and cached.
import { webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

function pemKey(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function serial(): string {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString("hex").replace(/^[89a-f]/, "1");
}

export class SandboxCA {
  private leaves = new Map<string, Promise<tls.SecureContext>>();

  private constructor(
    readonly certPem: string,
    private readonly keys: CryptoKeyPair,
    private readonly cert: x509.X509Certificate,
  ) {}

  /** Load the CA from dir (ca.pem + ca.key) or make a new one there. */
  static async open(dir: string): Promise<SandboxCA> {
    const certFile = join(dir, "ca.pem");
    const keyFile = join(dir, "ca.key");
    if (existsSync(certFile) && existsSync(keyFile)) {
      const certPem = readFileSync(certFile, "utf8");
      const keyPem = readFileSync(keyFile, "utf8");
      const der = Buffer.from(keyPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
      const priv = await webcrypto.subtle.importKey("pkcs8", der, ALG, true, ["sign"]);
      const cert = new x509.X509Certificate(certPem);
      const pub = await cert.publicKey.export(ALG, ["verify"]);
      return new SandboxCA(certPem, { privateKey: priv as unknown as CryptoKey, publicKey: pub }, cert);
    }
    const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
    const now = Date.now();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serial(),
      name: "CN=Fabwright Sandbox CA (this machine only), O=Fabwright",
      notBefore: new Date(now - 86_400_000),
      notAfter: new Date(now + 5 * 365 * 86_400_000),
      keys,
      signingAlgorithm: ALG,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)],
    });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(certFile, cert.toString("pem"));
    writeFileSync(keyFile, pemKey(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey as unknown as webcrypto.CryptoKey)), { mode: 0o600 });
    return new SandboxCA(cert.toString("pem"), keys, cert);
  }

  /** A TLS server context for `host`, signed by the CA (cached). */
  contextFor(host: string): Promise<tls.SecureContext> {
    const h = host.toLowerCase();
    let p = this.leaves.get(h);
    if (!p) {
      p = this.makeLeaf(h);
      this.leaves.set(h, p);
    }
    return p;
  }

  private async makeLeaf(host: string): Promise<tls.SecureContext> {
    return tls.createSecureContext(await this.leafPem(host));
  }

  /** A fresh key and certificate chain for `host` as PEM (a server in another thread or process can use them). */
  async leafPem(host: string): Promise<{ key: string; cert: string }> {
    const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
    const now = Date.now();
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: `CN=${host}`,
      issuer: this.cert.subject,
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + 30 * 86_400_000),
      signingKey: this.keys.privateKey,
      publicKey: keys.publicKey,
      signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([isIp ? { type: "ip", value: host } : { type: "dns", value: host }]),
      ],
    });
    const key = pemKey(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey as unknown as webcrypto.CryptoKey));
    return { key, cert: `${leaf.toString("pem").trim()}\n${this.certPem.trim()}\n` };
  }
}
