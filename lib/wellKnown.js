const express = require("express");

const router = express.Router();

// Both files need real values from accounts that don't exist yet (an Apple
// Developer team, an Android signing key). Until APPLE_TEAM_ID /
// ANDROID_CERT_SHA256 are set, 404 rather than serve a broken association -
// a missing file makes app links fall back to opening the website, which is
// a fine default; a malformed one can get iOS/Android to cache a bad result.

router.get("/apple-app-site-association", (req, res) => {
  const teamId = process.env.APPLE_TEAM_ID;
  if (!teamId) return res.status(404).end();

  res.type("application/json");
  res.json({
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.fyi.sejbosejbo`],
          components: [{ "/": "/post/*" }]
        }
      ]
    }
  });
});

router.get("/assetlinks.json", (req, res) => {
  // Comma-separated because Android needs both certs listed, not just one:
  // Play App Signing re-signs the APK that actually ships, so a build
  // installed from Play carries a different signature than the upload key
  // used for direct/sideloaded test builds. Only listing the Play
  // certificate means App Links can never be verified on a test build
  // before release.
  const fingerprints = String(process.env.ANDROID_CERT_SHA256 || "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (!fingerprints.length) return res.status(404).end();

  res.type("application/json");
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: process.env.ANDROID_PACKAGE_NAME || "com.thekingziga.sejbosejbo",
        sha256_cert_fingerprints: fingerprints
      }
    }
  ]);
});

module.exports = router;
