# Testing Cumulus for Mac and iOS

The shared library is `apps/cumulus-apple`. Its unit tests run on Linux and on a Mac. The app and the UI tests need Xcode.

No signing identity, provisioning profile, or secret is required. The Xcode project sets `CODE_SIGNING_ALLOWED` to `NO`.

## 1. Unit tests (Linux or Mac)

Install Swift 5.9 or newer. Swift 6.2 is what CI uses.

```bash
cd apps/cumulus-apple
swift test
```

This compiles `CumulusKit` and runs `CumulusKitTests`: SHA-256 and PKCE, OIDC authorize and token requests, ID-token claim checks, configuration hosts, mailbox folders and labels, and the mail, drive, and exchange clients against a fake HTTP transport.

You should see each `Test Case` reported as passed, and the suite summary `CumulusKitTests` passed.

## 2. Open the app in Xcode

1. Install Xcode 16 or newer.
2. Open `apps/cumulus-apple/Cumulus.xcodeproj`.
3. Wait until Xcode finishes resolving the local `CumulusKit` package. It is the folder that contains `Package.swift`, next to the project.
4. Select the `Cumulus` scheme.
5. Pick a run destination:
   - **My Mac** for macOS 14 or later
   - **iPhone** or **iPad** simulator, iOS 17 or later
6. Press **Run** (⌘R).

The first screen is Cumulus://Mail™, signed out, with **Sign in with your browser**. The top bar switches to Cumulus://ID™, Cumulus://Cloud™, and Download. Signing in opens the system browser at the issuer in `App/Resources/CumulusConfiguration.json` and returns to `cumulus://oauth/callback`. The tokens are written to the Keychain. There is no client secret in the project.

To look at the mailbox, drive, and exchange screens without a network, edit the scheme (**Product → Scheme → Edit Scheme → Run → Arguments**) and add:

```text
-CumulusPreview
```

That loads a local preview. It does not call the live APIs.

## 3. UI tests in Xcode

1. Select the `Cumulus` scheme.
2. Choose **My Mac** or an iOS Simulator.
3. Press **⌘U**, or **Product → Test**.

`CumulusUITests` launches the app twice:

- signed out, and checks the sign-in button, the product bar, and the download page
- with `-CumulusPreview`, and checks Compose, the VYRAL inbox row, My Drive, Exchange, and the Cumulus://ID address

If a test fails, the report navigator names the assertion. The preview launch does not need a Cumulus account.

## 4. The same builds from the terminal

From `apps/cumulus-apple`, with Xcode selected (`sudo xcode-select -s /Applications/Xcode.app`):

```bash
swift test

xcodebuild \
  -project Cumulus.xcodeproj \
  -scheme Cumulus \
  -destination 'generic/platform=macOS' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= \
  build

xcodebuild \
  -project Cumulus.xcodeproj \
  -scheme Cumulus \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= \
  build
```

UI tests on the Mac:

```bash
xcodebuild test \
  -project Cumulus.xcodeproj \
  -scheme Cumulus \
  -destination 'platform=macOS' \
  -only-testing:CumulusUITests \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM=
```

On an iPhone simulator, replace the destination with one that exists on the machine, for example:

```bash
xcrun simctl list devices available
xcodebuild test \
  -project Cumulus.xcodeproj \
  -scheme Cumulus \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:CumulusUITests \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM=
```

`generic/platform=iOS Simulator` builds the app. It does not boot a simulator, so use a named simulator for `xcodebuild test`.

## 5. GitHub Actions

`.github/workflows/cumulus-apple.yml` runs `swift test` on Ubuntu and on macOS, then `xcodebuild build` for macOS and the iOS Simulator with signing turned off, then the UI tests on macOS.

## What these tests do not cover

They do not sign in against the live issuer, upload a file to Drive, or send mail. Those calls are covered against a scripted HTTP client in `ClientTests`. A real sign-in needs a public OAuth client registered for `cumulus://oauth/callback`.
