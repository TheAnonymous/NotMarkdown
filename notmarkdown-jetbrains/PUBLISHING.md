# JetBrains Marketplace handoff

Build, verify, and inspect the plugin ZIP before any upload:

```sh
gradle buildPlugin verifyPlugin
```

The Marketplace plugin id is `org.notmarkdown.intellij`. The current baseline
uses the official LSP API and therefore targets IntelliJ Platform 2026.1
commercial IDEs. Do not claim IntelliJ Community or Android Studio support
until the planned native-language-API baseline exists.

For a first private review, create the Marketplace organisation/plugin record,
generate a narrowly scoped upload token, and expose it only as `PUBLISH_TOKEN`.
The IntelliJ Platform Gradle plugin reads that environment variable by default:

```sh
PUBLISH_TOKEN=<private-token> gradle publishPlugin
```

Plugin signing must be configured separately with `PRIVATE_KEY`,
`PRIVATE_KEY_PASSWORD`, and `CERTIFICATE_CHAIN` (or protected file-backed
equivalents). No key material belongs in this repository. Marketplace upload is
not part of the GitHub release workflow.

