/** Owns transient directory observations and rate reservations; never owns database state. */
export function createRemoteVerificationIO(dependencies: {
  list(path:string):Promise<string[]>;
  now():number;
  sleep(milliseconds:number):Promise<void>;
}) {
  const listings = new Map<string,{expiresAt:number;names:string[]}>();
  const pathReservations = new Map<string,number>();
  let nextAllowedAt = 0;
  let generation = 0;
  function clearListings() { generation++; listings.clear(); }
  return {
    clearListings,
    clearPathReservations() { pathReservations.clear(); },
    reset() { clearListings(); pathReservations.clear(); nextAllowedAt=0; },
    async list(path:string) {
      const now = dependencies.now();
      const cached = listings.get(path);
      if (cached && cached.expiresAt > now) return cached.names;
      const current = generation;
      const names = await dependencies.list(path);
      if (generation === current) listings.set(path,{expiresAt:now+30_000,names});
      return names;
    },
    async waitForSlot(rateLimitPerSecond:number,path:string) {
      const interval = Math.max(50,Math.floor(1000/rateLimitPerSecond));
      const now = dependencies.now();
      const allowed = Math.max(nextAllowedAt,pathReservations.get(path)||0);
      const next = Math.max(now,allowed)+interval;
      nextAllowedAt = next;
      pathReservations.set(path,next+Math.floor(interval/2));
      if (allowed > now) await dependencies.sleep(allowed-now);
    },
  };
}
