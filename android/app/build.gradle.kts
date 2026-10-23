plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.couchpilot.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.couchpilot.tv"
        minSdk = 22 // Fire OS 5 (Fire TV Stick 1st gen) and later
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    // The TV app itself is the web app in /web, bundled as assets: one codebase
    // for the browser, the Fire TV simulator workflow and the Fire OS device.
    sourceSets["main"].assets.srcDirs("../../web")
    // Fire TV decodes H.264 everywhere: ship MP4 only (the WebM copies are for desktop Chromium).
    androidResources { ignoreAssetsPattern = "!*.webm:!.*:!*~" }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.leanback:leanback:1.0.0")
}
