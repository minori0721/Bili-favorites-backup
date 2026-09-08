export interface QuiescenceClock {
  now():number;
  sleep(ms:number):Promise<void>;
}
const clock: QuiescenceClock = {now:Date.now,sleep:ms => new Promise(resolve => setTimeout(resolve,ms))};

/** Polls ownership state rather than racing abandoned timeout promises. */
export async function waitForQuiescence(isBusy:() => boolean, timeoutMs:number, time:QuiescenceClock = clock):Promise<boolean> {
  const deadline = time.now() + Math.max(0,timeoutMs);
  while (isBusy()) {
    const remaining = deadline - time.now();
    if (remaining <= 0) return false;
    await time.sleep(Math.min(25,remaining));
  }
  return true;
}
