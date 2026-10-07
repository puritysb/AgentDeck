# App Store growth materials — October 2026

Two custom product pages were created in App Store Connect from the approved iOS 1.8.0 product page. Their English and Korean promotional text clearly states the paired-Mac requirement. Existing iPhone screenshots and App Previews are inherited. Korean iPad screenshots are tailored: CI and fleet for Developer Workflow, fleet and attention for iPad Second Screen. Japanese visitors retain the English fallback; no Japanese localization was created in this work.

The iPad page contains the two new creative videos. These are separate from the retained 1.5.0 App Previews. [Manifest](manifest.json) records dimensions, hashes, the native capture source, and both page IDs. The source provenance is documented in [the Pages runbook](../../../docs/pages-site.md#180-scenario-supplement).

## Portal delivery

Both custom product pages were submitted on 2026-10-08 at 01:40 KST and App Store Connect showed **Waiting for Review** for each. [Submission](https://appstoreconnect.apple.com/apps/6784822497/distribution/reviewsubmissions/details/c02055ac-1dd7-4034-aa64-b976a82c2f2b). The two creative videos reached Ready for Review and are assigned to the iPad page in English. Approval and public availability remain separate. Screenshot evidence and the private Google Ads audit are retained locally under the ignored `evidence/` directory.

## Campaign links

App Store Connect generated provider token `128040795` for this developer account. The tracked README links use `github-readme-202610`; the Pages source uses `website-202610`; the Apple release-note template uses `release-202610`. These links target the default page until the custom pages are approved. The Mac release link retains `platform=mac`. A token only appears in Analytics after sufficient attributed downloads; generating a link does not create performance data.

## Measurement and follow-up

Compare first-time downloads by campaign, platform and country. Keep Apple opt-in usage and privacy-thresholded retention separate from total downloads. Run one Product Page Optimization treatment only after enough iOS traffic exists to reach a useful result within the 90-day limit. Compare practical session monitoring with the aquarium treatment while keeping other elements constant.

For the next substantial Apple update, prepare a Featuring Nomination around local AI-work visibility, the native aquarium and paired iPad experience. Choose a confirmed update or promotion date before submitting; Apple recommends at least two weeks notice. Routine fixes are not an In-App Event.

## Official references

- [Creative asset specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications)
- [Asset management and independent review](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-your-app-store-assets)
- [Custom product pages](https://developer.apple.com/app-store/custom-product-pages/)
- [Product Page Optimization](https://developer.apple.com/app-store/product-page-optimization/)
- [Featuring](https://developer.apple.com/app-store/getting-featured/)
