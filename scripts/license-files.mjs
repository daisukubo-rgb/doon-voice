// Preserve upstream document names, including LICENSE-MIT and LICENSE.BSD-3-Clause.
export function isLicenseDocument(name) {
  const sourceOrBinary = /\.(?:[cm]?jsx?|tsx?|map|rs|py|go|c|cc|cpp|h|hpp|o|a|so|dll|exe)$/i;
  return /^(licen[sc]e|notice|copyright|copying)(s|[._-].*)?$/i.test(name)
    && !sourceOrBinary.test(name);
}
