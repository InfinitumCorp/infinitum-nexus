# Cumulus for Mac, iPhone and iPad

One SwiftUI app for the Cumulus suite, plus the `CumulusKit` package the screens share.

| Product | What the app shows |
|---|---|
| Cumulus://ID™ | Sign-in with Cumulus://ID, then the account, aliases, plan and Cumulus Tunnel |
| Cumulus://Mail™ | Inbox, folders, labels, reader, composer, Clean, FIRM Wallet, People and Architect |
| Cumulus://Cloud™ | Cumulus://Drive (browse, upload, download, share links, versions, trash) and Cumulus Exchange opt-in licensing |
| Download | The Cumulus://Mail download page |

The layout follows the web apps already in this repo: white paper, ink `#111820`, muted `#52606b`, hairline `#d6dce1`, accent `#2454dd` for focus and links, Helvetica Neue, square corners, and text wordmarks with ™. Infinitum Corporation uses ®.

## Sign-in

Sign-in is OAuth 2.0 authorization code with PKCE (S256). The system browser is `ASWebAuthenticationSession`, and the callback is `cumulus://oauth/callback`. Tokens are stored in the Keychain (`app.cumuluscloud.suite` / `oidc`). The app is a public client. It does not contain a client secret.

The issuer is Cumulus://ID itself: `https://id.cumuluscloud.app/realms/cumulus`. The app client is `cumulus-apple`, registered in `packages/cid/src/id-clients.ts` with the single native callback `cumulus://oauth/callback`. ID tokens are checked against `<issuer>/protocol/openid-connect/certs`. Cumulus://ID signs with ES256 (CryptoKit); RS256 keys are also accepted. There is no client secret in the app.

Amazon Cognito sign-in was removed on 2026-11-18. A configuration whose issuer is a Cognito host is rejected, and old `cognito*` keys or `CUMULUS_COGNITO_*` variables are ignored.

## Configuration

`App/Resources/CumulusConfiguration.json` is the bundled list of API origins. Environment variables override it when any `CUMULUS_*` variable is set:

| Variable | Default |
|---|---|
| `CUMULUS_ID_ORIGIN` | `https://id.cumuluscloud.app` |
| `CUMULUS_ISSUER` | `https://id.cumuluscloud.app/realms/cumulus` |
| `CUMULUS_CLIENT_ID` | `cumulus-apple` |
| `CUMULUS_REDIRECT_URI` | `cumulus://oauth/callback` |
| `CUMULUS_MAIL_API` | `https://mail.cumuluscloud.app` |
| `CUMULUS_CLOUD_API` | `https://cloud.cumuluscloud.app` |
| `CUMULUS_EXCHANGE_API` | `https://cloud.cumuluscloud.app` |
| `CUMULUS_DOWNLOAD_PAGE` | `https://cumuluscloud.app` |

Mail calls send the access token as `Authorization: Bearer` and as the `cmail_session` cookie, plus `X-Cumulus: 1` on changes. Drive calls `https://cloud.cumuluscloud.app/v1`. Exchange calls `/v1/exchange/consents` and `/v1/exchange/licenses` on the exchange origin.

## Layout

```
apps/cumulus-apple/
  Package.swift              CumulusKit, built and tested with swift test
  Sources/CumulusKit/        models, PKCE, OIDC, mail, drive, exchange
  Tests/CumulusKitTests/     XCTest
  App/                       SwiftUI app (macOS 14+, iOS 17+)
  UITests/                   XCUITest smoke tests
  Cumulus.xcodeproj
```

Local test steps are in `docs/cumulus-apple/TESTING.md`.

Launch the app with `-CumulusPreview` to open a local mailbox and drive without the network. That argument is for the UI tests and for looking at the layout.
