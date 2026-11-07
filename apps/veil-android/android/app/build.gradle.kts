plugins {
    id("com.android.application")
}

android {
    namespace = "app.infinitum.veil"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.infinitum.veil"
        minSdk = 26
        targetSdk = 35
        versionCode = 6
        versionName = "0.1.5-debug"
        testApplicationId = "app.infinitum.veil.test"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(files("libs/veil.aar"))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
}
