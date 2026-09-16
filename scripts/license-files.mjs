// Preserve upstream document names, including LICENSE-MIT and LICENSE.BSD-3-Clause.
export function isLicenseDocument(name) {
  return /^(licen[sc]e|notice|copyright|copying)(s|[._-].*)?$/i.test(name);
}
