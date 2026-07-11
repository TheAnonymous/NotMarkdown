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
        description = "Deterministic NotMarkdown source support and package inspection."
        ideaVersion {
            sinceBuild = "261"
        }
        vendor {
            name = "NotMarkdown"
            url = "https://notmarkdown.org"
        }
    }
}

tasks {
    patchPluginXml {
        changeNotes = "Initial source language service and package inspection slice."
    }
}
