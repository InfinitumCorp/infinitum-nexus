# Cumulus ID Russian mirror (ru.id.cumuluscloud.app)

Russian networks throttle Cloudflare's free-plan addresses and AWS. Cloud Run and Google's front end
get through most of the time (2 of 3 tries, measured for Mail on 2026-11-11); Firebase Hosting's CDN
(Fastly) got through every time. So ru.id moves from a Cloud Run domain mapping to Firebase Hosting:

    before: phone -> ghs.googlehosted.com -> Cloud Run `spctr-mirror`  -> https://id.cumuluscloud.app
    after:  phone -> Firebase Hosting      -> Cloud Run `cumulus-id-ru` -> https://id.cumuluscloud.app

Both services run this `server.mjs`. `cumulus-id-ru` sets `COOKIE_JAR=1`: Firebase Hosting forwards
only the `__session` cookie, so the mirror packs Cumulus ID's cookies into it and unpacks them for
the Worker. `spctr-mirror` passes cookies through unchanged and stays up for rollback.

The host name doesn't change, so passkeys and `SPECTRE_EXTRA_ORIGINS` need nothing new.

## Set up (Google Cloud project `scalvs-mirror`, Firebase already enabled)

1. Deploy the pass-through:

       gcloud run deploy cumulus-id-ru --source . --project scalvs-mirror --region europe-north1 --allow-unauthenticated --set-env-vars UPSTREAM=https://id.cumuluscloud.app,COOKIE_JAR=1 --memory 256Mi --max-instances 3

2. Hosting site (with `GOOGLE_CLOUD_QUOTA_PROJECT=scalvs-mirror`):

       npx -y firebase-tools@14 hosting:sites:create cumulus-id-ru --project scalvs-mirror
       npx -y firebase-tools@14 deploy --only hosting --project scalvs-mirror

   Test at https://cumulus-id-ru.web.app (passkeys only work on ru.id itself).
3. Custom domain `ru.id.cumuluscloud.app` on site `cumulus-id-ru`. Before switching, add the
   ownership TXT and ACME records Firebase lists, so the certificate is ready first. Then point the
   `ru.id` CNAME at `cumulus-id-ru.web.app` (DNS only) instead of `ghs.googlehosted.com`.

Rollback: point the `ru.id` CNAME back at `ghs.googlehosted.com`.

`npm test` runs the cookie-jar and pass-through tests.
