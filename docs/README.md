# Jumper docs

## Start here

- [Quickstart](quickstart.md): install, run the app, run Blink.
- [Architecture](architecture.md): the packages, and how data moves from the canvas to the simulator and back.
- [Fidelity](fidelity.md): what the simulator can promise. Exact, Behavioral and Stub.
- [Native runtime](native-runtime.md): build and run firmware without Docker (`jumper setup`), and how Jumper picks Docker or native.

## For agents

- [Jumper for agents](agents.md): MCP setup for Claude Code and Codex, the loop, scenario steps, robots, faults.
- [MCP tools](mcp-tools.md): every tool, generated from the definitions.
- [Agent runs](media/agent-runs/README.md): Claude Code and Codex building a tamagotchi, a rover and a robot arm, with videos.

## Reference

- [Project format](project-format.md): `jumper.json`, an annotated example, and the diff-friendliness rules.
- [Part spec](part-spec.md): `part.json`, `fidelity.json`, SVG bindings, and the model contract.
- [Contracts](contracts.md): the APIs of every package.
- [Buses](buses.md): I2C and SPI in the simulator, bus parts, wiring errors and faults.
- [Cases and the factory pack](enclosures.md): any case shape, the parts laid out inside, print and factory files.
- [The build kit](build-kit.md): what to buy, print, assemble and flash to build it yourself (`get_build_kit`, Build it).
- [The hardware skill](agent-skill.md): how the design-for-assembly know-how reaches Claude and other agents (server instructions, prompts, project skill, CLAUDE.md, plugin).
- [Physics](../packages/physics/README.md): the robot `world` block, determinism, fidelity.
- [PWM](../packages/sim-core/PWM.md): cycle-timed PWM measurement and the part hooks it adds.

## Contributing

- [Adding a part](adding-a-part.md): the best first contribution.
- [Adding a board backend](adding-a-board-backend.md): a new MCU or emulator behind `McuBackend`.
- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, commands, commit style, labels.

## Design decisions

Each milestone starts with a short note: the options, the choice, and why.

- [0001 M0 foundations](decisions/0001-m0-foundations.md)

## Other

- [Brand](../brand/README.md): logo, colors, type, voice.
- [Original brief](brief.md): the product brief Jumper started from.
