const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Peak resident set size of this process so far. Node reports it in kilobytes. */
export function peakRssMb(): number {
  return mb(process.resourceUsage().maxRSS * 1024);
}

export function currentRssMb(): number {
  return mb(process.memoryUsage().rss);
}
