export function validHostname(site: string): boolean {
  return site.length > 0 && site.length <= 253 &&
    site.split(".").every((part) =>
      part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
    );
}
