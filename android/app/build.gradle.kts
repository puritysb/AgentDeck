import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.agentdeck"
    compileSdk = 34

    signingConfigs {
        create("release") {
            val envKeystore = System.getenv("ANDROID_KEYSTORE_PATH")
            if (envKeystore != null) {
                storeFile = file(envKeystore)
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                storePassword = System.getenv("ANDROID_STORE_PASSWORD")
            } else {
                val propsFile = rootProject.file("signing.properties")
                if (propsFile.exists()) {
                    val props = Properties()
                    propsFile.inputStream().use { props.load(it) }
                    storeFile = rootProject.file(props.getProperty("storeFile"))
                    keyAlias = props.getProperty("keyAlias")
                    keyPassword = props.getProperty("keyPassword")
                    storePassword = props.getProperty("storePassword")
                }
            }
        }
    }

    defaultConfig {
        applicationId = "dev.agentdeck"
        minSdk = 29
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.3"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.02.00")
    implementation(composeBom)

    // Compose
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")

    // Kotlin
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")

    // Networking
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.0.0")

    // Debug
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Test
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.11.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")
}
