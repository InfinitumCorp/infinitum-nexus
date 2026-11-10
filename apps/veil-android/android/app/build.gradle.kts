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
        // Ads stay off until ADS_ENABLED is flipped to true.
        buildConfigField("boolean", "ADS_ENABLED", "false")
        buildConfigField("String", "ADMOB_BANNER_ID", "\"ca-app-pub-3940256099942544/6300978111\"")
    }

    buildTypes {
        debug {
            isDebuggable = true
            buildConfigField("boolean", "ADS_ENABLED", "false")
            buildConfigField("String", "ADMOB_BANNER_ID", "\"ca-app-pub-3940256099942544/6300978111\"")
        }
        release {
            isMinifyEnabled = false
            // Flip ADS_ENABLED to true to serve the real banner in release. Off until then.
            buildConfigField("boolean", "ADS_ENABLED", "false")
            buildConfigField("String", "ADMOB_BANNER_ID", "\"ca-app-pub-7308175971826620/1130508906\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation("androidx.core:core:1.16.0")
    implementation("com.google.android.gms:play-services-ads:24.7.0")
    implementation("com.google.android.ump:user-messaging-platform:3.2.0")
    implementation(files("libs/veil.aar"))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
}
