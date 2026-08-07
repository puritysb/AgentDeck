plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.3.21" apply false
    // Required from Kotlin 2.0: the Compose compiler ships as its own Gradle
    // plugin instead of `composeOptions.kotlinCompilerExtensionVersion`.
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.3.21" apply false
}
