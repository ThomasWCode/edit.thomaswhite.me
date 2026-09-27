// The site repository's checkout, for the scripts that run its drafts code:
// SITE_REPO if set, else ThomasWCode.github.io-revised next to this repository.
import { pathToFileURL } from "node:url";

export const siteRepo = process.env.SITE_REPO
  ? pathToFileURL(`${process.env.SITE_REPO.replace(/\/?$/, "/")}`)
  : new URL("../../../../ThomasWCode.github.io-revised/", import.meta.url);

export const siteDrafts = () => import(new URL("scripts/drafts.mjs", siteRepo).href);
