// Fabwright TLS trust shim (simulation builds only), Apache-2.0.
//
// Fabwright's sandbox network terminates TLS for the hosts it inspects (mocks, cassettes, secrets
// added at the edge) with a certificate from a per-machine sandbox CA. A sketch written for the real
// device sets the real root CA (setCACert), the certificate bundle, or setInsecure(); none of them
// trusts the sandbox. mbedTLS checks a server chain with mbedtls_x509_crt_verify_restartable(),
// which this file wraps (-Wl,--wrap): the sketch's own trust anchors are tried first, unchanged,
// and only if they reject the chain is it checked again against the sandbox CA. The CA comes from
// the sandbox network when the board joins; it is not in the firmware, and the real-device build
// does not contain this file. Hosts in tls "passthrough" mode present their real certificate and
// are verified by the sketch's own CAs as on the device.
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "mbedtls/x509_crt.h"

static mbedtls_x509_crt s_ca;
static int s_ca_ok;

void fabwright_sim_set_ca(const unsigned char *der, size_t len) {
  if (s_ca_ok) {
    if (s_ca.raw.len == len && memcmp(s_ca.raw.p, der, len) == 0) return;
    mbedtls_x509_crt_free(&s_ca);
    s_ca_ok = 0;
  }
  mbedtls_x509_crt_init(&s_ca);
  if (mbedtls_x509_crt_parse_der(&s_ca, der, len) == 0) s_ca_ok = 1;
  else ESP_LOGE("fabwright_tls", "the sandbox CA from Fabwright could not be parsed; TLS to inspected hosts will fail");
}

int __real_mbedtls_x509_crt_verify_restartable(mbedtls_x509_crt *crt, mbedtls_x509_crt *trust_ca, mbedtls_x509_crl *ca_crl,
                                               const mbedtls_x509_crt_profile *profile, const char *cn, uint32_t *flags,
                                               int (*f_vrfy)(void *, mbedtls_x509_crt *, int, uint32_t *), void *p_vrfy,
                                               mbedtls_x509_crt_restart_ctx *rs_ctx);

int __wrap_mbedtls_x509_crt_verify_restartable(mbedtls_x509_crt *crt, mbedtls_x509_crt *trust_ca, mbedtls_x509_crl *ca_crl,
                                               const mbedtls_x509_crt_profile *profile, const char *cn, uint32_t *flags,
                                               int (*f_vrfy)(void *, mbedtls_x509_crt *, int, uint32_t *), void *p_vrfy,
                                               mbedtls_x509_crt_restart_ctx *rs_ctx) {
  int ret = __real_mbedtls_x509_crt_verify_restartable(crt, trust_ca, ca_crl, profile, cn, flags, f_vrfy, p_vrfy, rs_ctx);
  if (ret == 0 || !s_ca_ok) return ret;
  uint32_t f2 = 0;
  if (__real_mbedtls_x509_crt_verify_restartable(crt, &s_ca, NULL, profile, cn, &f2, f_vrfy, p_vrfy, NULL) == 0) {
    *flags = 0;
    return 0;
  }
  return ret;
}
