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

The default issuer is the live Cognito user pool behind `id.cumuluscloud.app`. The public identifiers are region `us-east-1`, pool `us-east-1_fRlMO7dna`, app client `60bejetr2agt2l6n5gk3v9tmd2`, and hosted UI `cumulus-id.auth.us-east-1.amazoncognito.com`. ID tokens are checked with RS256 against `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna/.well-known/jwks.json`. There is no client secret in the app.

Before a real sign-in works, `cumulus://oauth/callback` has to be on that app client's allowed callback URLs. That is an owner step in the Cognito console. It is not done in this repository.

## Configuration

`App/Resources/CumulusConfiguration.json` is the bundled list of API origins. Environment variables override it when any `CUMULUS_*` variable is set:

| Variable | Default |
|---|---|
| `CUMULUS_ID_ORIGIN` | `https://id.cumuluscloud.app` |
| `CUMULUS_ISSUER` | `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna` |
| `CUMULUS_CLIENT_ID` | `60bejetr2agt2l6n5gk3v9tmd2` |
| `CUMULUS_REDIRECT_URI` | `cumulus://oauth/callback` |
| `CUMULUS_MAIL_API` | `https://mail.cumuluscloud.app` |
| `CUMULUS_CLOUD_API` | `https://cloud.cumuluscloud.app` |
| `CUMULUS_EXCHANGE_API` | `https://cloud.cumuluscloud.app` |
| `CUMULUS_DOWNLOAD_PAGE` | `https://cumuluscloud.app` |
| `CUMULUS_COGNITO_DOMAIN` | `cumulus-id.auth.us-east-1.amazoncognito.com` |
| `CUMULUS_COGNITO_REGION` | `us-east-1` |
| `CUMULUS_COGNITO_USER_POOL_ID` | `us-east-1_fRlMO7dna` |

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
