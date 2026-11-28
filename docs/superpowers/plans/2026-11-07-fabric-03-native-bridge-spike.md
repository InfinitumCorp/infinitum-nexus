# Native bridge spike: encrypted Matrix store on Android and iOS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, before any screens are built, that an Expo app can build a Matrix Rust SDK client with an encrypted store whose key never leaves native code, log in to the local Synapse, survive relaunch, fail closed when the key is missing, and wipe on logout — on an Android emulator and an iOS simulator.

**Architecture:** An Expo development build with one local Expo module, `fabric-matrix`. Swift and Kotlin code generate a 32-byte store key, keep it in Keychain / a Keystore-wrapped file, and pass it to `SqliteStoreBuilder.key(..)`. JavaScript sees only `{ userId, deviceId }` and error codes.

**Tech Stack:** Expo SDK 58 (`expo@58.0.23`, `expo-dev-client@58.0.18`), Expo Modules API, `matrix-rust-components-swift`, `org.matrix.rustcomponents:sdk-android`, Synapse from Stage 2.

## Global Constraints

- No custom cryptography. The SDK does all message and store encryption; native code only generates and protects the store key.
- The store key, access token and password never cross into JavaScript and are never logged.
- Fail closed: if the key is missing or cannot be unwrapped while a store exists, the module throws `store_locked` and builds no client. It never opens an unencrypted or in-memory store with real data.
- iOS Keychain item: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable.
- Android: key wrapped with an AES-256-GCM key in `AndroidKeyStore` (StrongBox when available); wrapped bytes in app-private storage.
- Expo Go is not supported; development builds only.
- Do not import `@infinitum/fabric` anywhere.
- No signing for distribution, no store submission. Free Apple ID signing on a personal device is allowed later but not needed here (simulator only).

Location: `<app-repo>/` (index decision 1). Requires Android Studio (emulator) and a Mac with Xcode. Results from one platform must not be reported for the other.

---

### Task 1: Version gate and app shell

**Files:**
- Create: `<app-repo>/app/` via `create-expo-app`
- Create: `<app-repo>/app/VERSIONS.md`

- [ ] **Step 1: Pick the binding pair**

Open the release page of `matrix-rust-components-swift` 26.10.27 (commit `e675036…`) and the POM / release notes of each `sdk-android` version (26.10.23, 26.11.05). Choose the Android version built from the same matrix-rust-sdk commit if one exists. If none does, choose the nearest and diff `bindings/matrix-sdk-ffi/src/{client_builder,store,client}.rs` between the two commits for the functions this plan uses: `ClientBuilder.new/homeserver_url/sqlite_store/build`, `SqliteStoreBuilder.new/key`, `Client.login/user_id/device_id/logout`. Record the result.

- [ ] **Step 2: Create the app and record versions**

Run:

```bash
npx create-expo-app@latest app --template blank-typescript
cd app && npx expo install expo@58.0.23 expo-dev-client && npx expo install --check
npx create-expo-module@latest --local fabric-matrix
```

Write `app/VERSIONS.md` with the exact versions from `package.json`, the chosen Swift and Kotlin binding versions and their matrix-rust-sdk commits, and the result of Step 1.

Expected: `npx expo install --check` reports dependencies up to date. If `create-expo-module --local` prompts, accept the module name `fabric-matrix`.

- [ ] **Step 3: Commit**

```bash
git add app
git commit -m "app: Expo SDK 58 shell, local fabric-matrix module, pinned versions"
```

### Task 2: Android store key and client

**Files:**
- Modify: `app/modules/fabric-matrix/android/build.gradle` (dependency)
- Create: `app/modules/fabric-matrix/android/src/main/java/expo/modules/fabricmatrix/StoreKey.kt`
- Modify: `app/modules/fabric-matrix/android/src/main/java/expo/modules/fabricmatrix/FabricMatrixModule.kt`

**Interfaces:**
- Produces (JS): `login(homeserver: string, username: string, password: string): Promise<{ userId: string; deviceId: string }>`
- Produces (JS): `restore(homeserver: string): Promise<{ userId: string; deviceId: string } | null>` — `null` when no store exists
- Produces (JS): `logoutAndWipe(): Promise<void>`
- Errors (JS `code`): `store_locked`, `login_failed`

- [ ] **Step 1: Add the dependency**

In `android/build.gradle` `dependencies { }` add, with the version chosen in Task 1:

```gradle
implementation "org.matrix.rustcomponents:sdk-android:<version from VERSIONS.md>"
```

- [ ] **Step 2: Store key**

`StoreKey.kt`:

```kotlin
package expo.modules.fabricmatrix

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class StoreLockedException : Exception("store_locked")

object StoreKey {
  private const val ALIAS = "fabric_store_wrap"
  private fun file(ctx: Context) = File(ctx.noBackupFilesDir, "store.key.wrapped")

  private fun wrapKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
    try { spec.setIsStrongBoxBacked(true); gen.init(spec.build()) } catch (e: Exception) { spec.setIsStrongBoxBacked(false); gen.init(spec.build()) }
    return gen.generateKey()
  }

  /** Creates a new key. Only called when no store exists. */
  fun create(ctx: Context): ByteArray {
    val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, wrapKey()) }
    file(ctx).writeBytes(c.iv + c.doFinal(key))
    return key
  }

  /** Returns the key, or throws StoreLockedException. Never creates one. */
  fun load(ctx: Context): ByteArray {
    val f = file(ctx)
    if (!f.exists()) throw StoreLockedException()
    return try {
      val b = f.readBytes()
      val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, b, 0, 12)) }
      c.doFinal(b, 12, b.size - 12)
    } catch (e: Exception) { throw StoreLockedException() }
  }

  fun delete(ctx: Context) {
    file(ctx).delete()
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
  }
}
```

- [ ] **Step 3: Module**

Replace `FabricMatrixModule.kt` with:

```kotlin
package expo.modules.fabricmatrix

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import java.io.File

class FabricMatrixModule : Module() {
  private var client: Client? = null
  private val ctx get() = requireNotNull(appContext.reactContext)
  private fun storeDir() = File(ctx.noBackupFilesDir, "matrix")

  private suspend fun build(homeserver: String, key: ByteArray): Client {
    val dir = storeDir().apply { mkdirs() }.absolutePath
    return ClientBuilder()
      .homeserverUrl(homeserver)
      .sqliteStore(SqliteStoreBuilder(dir, dir).key(key))
      .build()
  }

  private fun wipe() {
    storeDir().deleteRecursively()
    StoreKey.delete(ctx)
  }

  override fun definition() = ModuleDefinition {
    Name("FabricMatrix")

    AsyncFunction("restore") Coroutine { homeserver: String ->
      if (!storeDir().exists()) return@Coroutine null
      val key = try { StoreKey.load(ctx) } catch (e: StoreLockedException) { throw CodedException("store_locked", "Store key unavailable", null) }
      val c = build(homeserver, key)
      client = c
      mapOf("userId" to c.userId(), "deviceId" to c.deviceId())
    }

    AsyncFunction("login") Coroutine { homeserver: String, username: String, password: String ->
      wipe()
      val c = build(homeserver, StoreKey.create(ctx))
      try { c.login(username, password, "FabriC++", null) } catch (e: Exception) { wipe(); throw CodedException("login_failed", "Login failed", null) }
      client = c
      mapOf("userId" to c.userId(), "deviceId" to c.deviceId())
    }

    AsyncFunction("logoutAndWipe") Coroutine { ->
      try { client?.logout() } catch (e: Exception) { }
      client = null
      wipe()
    }
  }
}
```

The Kotlin names (`homeserverUrl`, `sqliteStore`, `SqliteStoreBuilder(dir, dir)`, `.key(ByteArray?)`, `build()` as `suspend`, `login(String, String, String?, String?)`, `userId()`, `deviceId()`, `logout()`) are UniFFI's camel-case forms of the Rust functions listed in the index. Compilation in Step 4 is the test of that mapping; if a name differs in the chosen version, use the generated name and record it in `VERSIONS.md`.

- [ ] **Step 4: Build**

Run: `cd app && npx expo run:android`
Expected: the app installs on the emulator. Report the actual result; a compile error here means the binding names differ and must be fixed before continuing.

- [ ] **Step 5: Commit**

```bash
git add app/modules/fabric-matrix/android
git commit -m "fabric-matrix (Android): Keystore-wrapped store key, encrypted SDK store, login/restore/wipe"
```

### Task 3: iOS store key and client

**Files:**
- Modify: `app/modules/fabric-matrix/ios/FabricMatrix.podspec` or the module's Swift package dependency (whichever `create-expo-module` produced) to add `matrix-rust-components-swift` at the version from `VERSIONS.md`
- Create: `app/modules/fabric-matrix/ios/StoreKey.swift`
- Modify: `app/modules/fabric-matrix/ios/FabricMatrixModule.swift`

**Interfaces:** identical JS functions and error codes to Task 2.

- [ ] **Step 1: Store key**

`StoreKey.swift`:

```swift
import Foundation
import Security

enum StoreKeyError: Error { case locked }

enum StoreKey {
  private static let service = "fabric.store.key"

  private static func query() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrSynchronizable as String: false]
  }

  static func create() throws -> Data {
    var bytes = Data(count: 32)
    let rc = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard rc == errSecSuccess else { throw StoreKeyError.locked }
    SecItemDelete(query() as CFDictionary)
    var add = query()
    add[kSecValueData as String] = bytes
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw StoreKeyError.locked }
    return bytes
  }

  static func load() throws -> Data {
    var q = query()
    q[kSecReturnData as String] = true
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { throw StoreKeyError.locked }
    return d
  }

  static func delete() { SecItemDelete(query() as CFDictionary) }
}
```

- [ ] **Step 2: Module**

Replace `FabricMatrixModule.swift` with:

```swift
import ExpoModulesCore
import MatrixRustSDK

public class FabricMatrixModule: Module {
  private var client: Client?
  private let installMarker = "fabric.installed"

  private var storeDir: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("matrix")
  }

  private func build(_ homeserver: String, _ key: Data) async throws -> Client {
    try FileManager.default.createDirectory(at: storeDir, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let store = SqliteStoreBuilder(dataPath: storeDir.path, cachePath: storeDir.path).key(key: key)
    return try await ClientBuilder().homeserverUrl(url: homeserver).sqliteStore(config: store).build()
  }

  private func wipe() {
    try? FileManager.default.removeItem(at: storeDir)
    StoreKey.delete()
  }

  public func definition() -> ModuleDefinition {
    Name("FabricMatrix")

    OnCreate {
      // Keychain items can survive uninstall; app files cannot. A fresh install has no marker.
      if !UserDefaults.standard.bool(forKey: self.installMarker) {
        self.wipe()
        UserDefaults.standard.set(true, forKey: self.installMarker)
      }
    }

    AsyncFunction("restore") { (homeserver: String) async throws -> [String: String]? in
      guard FileManager.default.fileExists(atPath: self.storeDir.path) else { return nil }
      guard let key = try? StoreKey.load() else { throw Exception(name: "store_locked", description: "Store key unavailable") }
      let c = try await self.build(homeserver, key)
      self.client = c
      return ["userId": try c.userId(), "deviceId": try c.deviceId()]
    }

    AsyncFunction("login") { (homeserver: String, username: String, password: String) async throws -> [String: String] in
      self.wipe()
      let c = try await self.build(homeserver, try StoreKey.create())
      do { try await c.login(username: username, password: password, initialDeviceName: "FabriC++", deviceId: nil) }
      catch { self.wipe(); throw Exception(name: "login_failed", description: "Login failed") }
      self.client = c
      return ["userId": try c.userId(), "deviceId": try c.deviceId()]
    }

    AsyncFunction("logoutAndWipe") { () async in
      try? await self.client?.logout()
      self.client = nil
      self.wipe()
    }
  }
}
```

The Swift labels follow UniFFI's Swift conventions for the Rust functions in the index; Step 3's build is the test of that mapping. Use the generated names if they differ and record them in `VERSIONS.md`.

- [ ] **Step 3: Build (Mac only)**

Run: `cd app && npx expo run:ios`
Expected: the app launches in the iOS simulator. This step cannot run on the Linux box.

- [ ] **Step 4: Commit**

```bash
git add app/modules/fabric-matrix/ios
git commit -m "fabric-matrix (iOS): Keychain store key, encrypted SDK store, login/restore/wipe"
```

### Task 4: JS wrapper and spike screen

**Files:**
- Modify: `app/modules/fabric-matrix/index.ts`
- Modify: `app/App.tsx`

- [ ] **Step 1: Typed wrapper**

`modules/fabric-matrix/index.ts`:

```ts
import { requireNativeModule } from "expo-modules-core";

export type Session = { userId: string; deviceId: string };

type Native = {
  restore(homeserver: string): Promise<Session | null>;
  login(homeserver: string, username: string, password: string): Promise<Session>;
  logoutAndWipe(): Promise<void>;
};

const native = requireNativeModule<Native>("FabricMatrix");

export const restore = (homeserver: string) => native.restore(homeserver);
export const login = (homeserver: string, username: string, password: string) => native.login(homeserver, username, password);
export const logoutAndWipe = () => native.logoutAndWipe();
```

- [ ] **Step 2: Spike screen**

`App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Button, Platform, Text, TextInput, View } from "react-native";
import { login, logoutAndWipe, restore, type Session } from "./modules/fabric-matrix";

const HS = Platform.OS === "android" ? "http://10.0.2.2:8008" : "http://127.0.0.1:8008";

export default function App() {
  const [s, setS] = useState<Session | null>(null);
  const [err, setErr] = useState("");
  const [u, setU] = useState("alice");
  const [p, setP] = useState("");
  useEffect(() => { restore(HS).then(setS).catch((e) => setErr(String(e.code ?? "error"))); }, []);
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff", padding: 24, paddingTop: 80, gap: 12 }}>
      <Text style={{ color: "#111820", fontSize: 32, fontWeight: "400" }}>FabriC++</Text>
      <Text style={{ color: "#52606b" }}>{s ? `${s.userId} · ${s.deviceId}` : "Signed out"}</Text>
      {err ? <Text style={{ color: "#2454dd" }}>{err}</Text> : null}
      <TextInput value={u} onChangeText={setU} autoCapitalize="none" style={{ borderBottomWidth: 1, borderColor: "#d6dce1" }} />
      <TextInput value={p} onChangeText={setP} secureTextEntry style={{ borderBottomWidth: 1, borderColor: "#d6dce1" }} />
      <Button title="Sign in" color="#2454dd" onPress={() => login(HS, u, p).then((x) => { setS(x); setErr(""); }).catch((e) => setErr(String(e.code ?? "error")))} />
      <Button title="Sign out and wipe" color="#2454dd" onPress={() => logoutAndWipe().then(() => setS(null))} />
    </View>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/modules/fabric-matrix/index.ts app/App.tsx
git commit -m "app: spike screen for sign-in, restore and wipe"
```

### Task 5: Spike checklist (run on each platform separately)

Prerequisite: Stage 2 server running with users `alice` / `bob`.

- [ ] **Step 1: Sign in** — enter `alice` and her password. Expected: `@alice:fabric.localhost · <device id>`.
- [ ] **Step 2: Wrong password** — Expected: `login_failed`; no store directory left behind.
- [ ] **Step 3: Relaunch** — kill and reopen the app. Expected: the same user and device id appear without signing in.
- [ ] **Step 4: Store is not plaintext** — Android: `adb exec-out run-as <applicationId> sh -c 'cat no_backup/matrix/*' | grep -c "<alice's password>"`; iOS simulator: `grep -rc "<alice's password>" "$(xcrun simctl get_app_container booted <bundleId> data)/Library/Application Support/matrix"`. Expected: 0 matches. Also grep for the access token from the device's sign-in (read it from Synapse's `access_tokens` table): expected 0 matches.
- [ ] **Step 5: Fail closed** — Android: `adb shell run-as <applicationId> rm no_backup/store.key.wrapped`, relaunch. iOS: add a temporary debug-only call to `StoreKey.delete()` in `OnCreate` after the marker check, relaunch, then remove it. Expected: `store_locked`, no session shown, no crash, and no client is built.
- [ ] **Step 6: Wipe** — sign in, tap "Sign out and wipe". Expected: "Signed out"; store directory and key are gone; Synapse shows the device removed (`select count(*) from devices where user_id='@alice:fabric.localhost'` drops by one).
- [ ] **Step 7: iOS reinstall** — sign in, delete the app, reinstall, open. Expected: "Signed out" (stale Keychain key removed by the install marker).
- [ ] **Step 8: Record** — write the results for each platform, with dates and device names, into `app/SPIKE-RESULTS.md` and commit. Any failed step stops Stage 5.

Sending and receiving encrypted messages, verification and the `check-no-plaintext.sh` positive run are added at the start of Stage 5 on top of this proven base.
