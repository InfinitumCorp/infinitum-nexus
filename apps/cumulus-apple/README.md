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

The default issuer is the Cumulus://ID Keycloak realm:

`https://id.cumuluscloud.app/realms/cumulus`

Amazon Cognito is used when all three public settings are present: `cognitoDomain`, `cognitoRegion`, and `cognitoUserPoolID`. Register a public app client (authorization code, PKCE, no secret) with that callback. Do not put `COGNITO_CLIENT_SECRET` in the app or in git.

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
| `CUMULUS_COGNITO_DOMAIN` | unset |
| `CUMULUS_COGNITO_REGION` | unset |
| `CUMULUS_COGNITO_USER_POOL_ID` | unset |

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
