plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    id("org.jetbrains.intellij.platform") version "2.18.0"
}

group = "org.notmarkdown"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        intellijIdea("2026.1.4")
        pluginVerifier()
        zipSigner()
    }
}

kotlin { jvmToolchain(21) }

intellijPlatform {
    pluginConfiguration {
        id = "org.notmarkdown.intellij"
        name = "NotMarkdown"
        version = project.version.toString()
        description = """
            <p>Deterministic NotMarkdown source support and safe package inspection.</p>
            <ul>
              <li><code>.nmt</code> and <code>.nmdoc</code> file types</li>
              <li>Diagnostics, completion, hover, and structure through the shared LSP</li>
              <li>Explicit package inspection and complete verification actions</li>
            </ul>
            <p>Documents are never executed and no network access is required.</p>
        """.trimIndent()
        ideaVersion {
            sinceBuild = "261"
        }
        vendor {
            name = "NotMarkdown"
            url = "https://theanonymous.github.io/NotMarkdown/"
        }
    }
}

tasks {
    patchPluginXml {
        changeNotes = """
            <ul>
              <li>Initial NotMarkdown language-service integration.</li>
              <li>Safe package inspection and complete verification actions.</li>
              <li>Exact Mermaid, Vega-Lite, and draw.io source support from the shared toolchain.</li>
            </ul>
        """.trimIndent()
    }
}
