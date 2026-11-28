/**
 * Postfix pipe transport for Cumulus://Mail in Node mode. See the README ("Node mode with Postfix").
 *
 *   cumulus unix - n n - - pipe flags=Rq user=cumulus-mail
 *     argv=/usr/bin/node --experimental-strip-types /opt/cumulus-mail/apps/cumulus-mail/scripts/postfix-deliver.ts
 *     --url http://127.0.0.1:3011/inbound --token-file /etc/cumulus-mail/inbound.token -- ${sender} ${recipient}
 */
import { EX_TEMPFAIL, deliverToMail, parseArgs } from "../src/postfix-pipe.ts";

try {
  const args = parseArgs(process.argv.slice(2));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const { code, message } = await deliverToMail(args, new Uint8Array(Buffer.concat(chunks)));
  if (code !== 0) console.error(message);
  process.exit(code);
} catch (err) {
  console.error((err as Error).message);
  process.exit(EX_TEMPFAIL);
}
