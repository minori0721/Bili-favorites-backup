// Local source checkout fallback. Container builds replace this with Dockerfile metadata.
export const BBDOWN_BUILD_INFO = {
  release: "local",
  commit: "local",
  sha256: "local",
} as const;
