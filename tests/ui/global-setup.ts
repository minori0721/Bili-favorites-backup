import { startFakeUiServer } from "./fake-server.js";

export default async function globalSetup() {
  const close = await startFakeUiServer();
  return async () => {
    await close();
  };
}
