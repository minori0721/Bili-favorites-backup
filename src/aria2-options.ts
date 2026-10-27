// BFB only downloads HTTP media. Do not interpret a response as a new torrent
// or Metalink job; the existing media verifier still validates the saved file.
export const ARIA2_DOWNLOAD_ARGS = [
  '--continue=true', '--always-resume=true', '--max-resume-failure-tries=0',
  '--auto-save-interval=5', '--auto-file-renaming=false', '--allow-overwrite=true',
  '--file-allocation=none', '--connect-timeout=10', '--timeout=30',
  '--max-tries=5', '--retry-wait=3',
  '--follow-torrent=false', '--follow-metalink=false',
  '--check-certificate=true', '--min-tls-version=TLSv1.2',
] as const;
