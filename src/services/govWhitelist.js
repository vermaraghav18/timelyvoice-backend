// backend/src/services/govWhitelist.js
"use strict";
module.exports = {
  allowedDomains: [
    // Keep this short to start; we can add more later
    ".gov.in",
    ".nic.in",
    "pib.gov.in",
    "mea.gov.in",
    "mha.gov.in",
    "pmindia.gov.in",
    "mygov.in",
  ],
  isGovUrl(url = "") {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return this.allowedDomains.some((d) => host === d || host.endsWith(d));
    } catch {
      return false;
    }
  },
};
