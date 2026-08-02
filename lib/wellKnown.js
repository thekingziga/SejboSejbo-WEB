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
  const fingerprint = process.env.ANDROID_CERT_SHA256;
  if (!fingerprint) return res.status(404).end();

  res.type("application/json");
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "fyi.sejbosejbo",
        sha256_cert_fingerprints: [fingerprint]
      }
    }
  ]);
});

module.exports = router;
