import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './signaling.mjs';
import { TurnServer } from './turn.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
const publicDir = path.join(root, 'public');
const evidenceDir = path.join(root, 'evidence');

const turnPort = Number(process.env.TURN_PORT || 3478);
const turnControlPort = Number(process.env.TURN_CONTROL_PORT || 3479);

process.env.TURN_URL ??= `turn:${host}:${turnPort}?transport=udp`;
process.env.TURN_USER ??= 'demo';
process.env.TURN_PASS ??= 'demo-pass';

if (process.env.NO_TURN !== '1') {
  new TurnServer({
    port: turnPort,
    host,
    controlPort: turnControlPort,
  }).start();
}

const { server } = createApp({ publicDir, evidenceDir });
server.listen(port, host, () => {
  console.log(`[web] http://${host}:${port}`);
  console.log(`[web] presenter  /presenter.html?room=DEMO`);
  console.log(`[web] viewer     /viewer.html?room=DEMO`);
  console.log(`[web] capture-fixture /fixture.html (演示素材)`);
});
