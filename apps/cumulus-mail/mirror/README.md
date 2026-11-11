# Cumulus://Mail Russian mirror (ru2.mail.cumuluscloud.app)

Russian networks throttle Cloudflare's free-plan addresses (188.114.96–97.x) and AWS: a connection
freezes after roughly 16–24 KB. Firebase Hosting's CDN (Fastly) and Google's CDN get through.
Measured from a phone on a Russian network on 2026-11-11, three rounds each:

| Host | Result |
|---|---|
| mail.cumuluscloud.app (Cloudflare) | 0/3 |
| ru.mail.cumuluscloud.app (AWS) | 0/3, freezes at ~24 KB |
| Cloud Run (run.app) | 2/3 |
| Fastly, Google CDN | 3/3, ~400 KB/s |

So this mirror is:

    phone -> Firebase Hosting (Fastly) -> Cloud Run `cumulus-mail-mirror` (server.mjs) -> https://mail.cumuluscloud.app

Firebase Hosting forwards only the `__session` cookie, so `server.mjs` packs Mail's cookies
(`cmail_session`, `cmail_oauth`) into it and unpacks them for the Worker. Redirects back to
mail.cumuluscloud.app are rewritten to the mirror. Passkeys work because the mirror is under
mail.cumuluscloud.app and listed in the Worker's `MAIL_EXTRA_ORIGINS` (cloudflare.config.ts).

## Set up (Google Cloud project `scalvs-mirror`)

1. Once per Google account: open https://console.firebase.google.com, choose "Add project",
   pick the existing `scalvs-mirror` project and accept the Firebase terms.
2. Deploy the pass-through:

       gcloud run deploy cumulus-mail-mirror --source . --project scalvs-mirror --region europe-north1 --allow-unauthenticated --set-env-vars UPSTREAM=https://mail.cumuluscloud.app,PUBLIC_ORIGIN=https://ru2.mail.cumuluscloud.app --memory 256Mi --max-instances 3

3. Create the Hosting site and deploy `firebase.json`:

       npx -y firebase-tools@14 hosting:sites:create cumulus-mail-ru --project scalvs-mirror
       npx -y firebase-tools@14 deploy --only hosting --project scalvs-mirror

   The mirror is then live at https://cumulus-mail-ru.web.app.
4. Custom domain: Firebase console > Hosting > cumulus-mail-ru > Add custom domain >
   `ru2.mail.cumuluscloud.app`. Add the records it shows in Cloudflare DNS as **DNS only**
   (grey cloud), then wait for the certificate.
5. Redeploy the Mail Worker so `https://ru2.mail.cumuluscloud.app` is an allowed origin.

`npm test` runs the cookie-jar and redirect tests.
