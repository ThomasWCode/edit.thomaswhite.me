September 2026, age 16

# How this site works

Most of this website is stuff you can’t see: the tests, checks and monitoring that stop it breaking. This is how it fits together.

<!--
Brief (content strategy §9.3). 600 to 900 words. This first version was drafted from the repository for Tom to rewrite in his own voice; every claim below can be checked against the code. Replace the last section with your own paragraph.
-->

## Plain HTML, on purpose

Every page is hand-written HTML and CSS, with one JavaScript file shared by all of them. There’s no framework and no build step: the files in the repository are the files you’re looking at, served by GitHub Pages.

The fonts, Inter and Fraunces, are hosted on the site itself rather than loaded from Google, and every big photo comes in smaller WebP versions so a phone doesn’t download a 6,000-pixel image. The downside of no build step is that the header and footer are copied into every page, which is part of why the next bit exists.

## Tests for everything

Every change runs through the whole test suite on GitHub Actions.

- Static checks read every page and make sure the basics hold: one main heading, a description, a canonical link, valid HTML, images whose declared sizes match the real files, and no link to a file that doesn’t exist.
- Playwright opens every page in Chromium at desktop and phone sizes, with reduced motion and with JavaScript turned off, and runs quicker smoke tests in Firefox and WebKit. It tries the navigation, the contact form (against a fake Formspree) and the gallery, and runs axe accessibility checks on every page.
- Visual regression tests take screenshots of key pages and compare them with approved ones, so a stray CSS change can’t quietly break the layout.
- Lighthouse audits the main pages three times each and fails if the median performance, accessibility, best-practice or SEO score drops below its budget.
- ESLint and Stylelint catch mistakes in the JavaScript and CSS.

## Watching the live site

Tests only prove the code works on my side. Better Stack checks the site’s pages every three minutes from four locations and publishes the results on a status page (https://status.thomaswhite.me/), linked in the footer. A scheduled job also checks the live pages every morning, and the links to other sites once a week.

## Small things that matter

Analytics only load if you agree to them in the cookie banner. The “Last updated” date in the footer comes from the server’s record of when the site was published, not from something I have to remember to change. The navigation measures how much room it has and moves pages into “More” instead of wrapping onto two lines.

Once a month, a script reads every page for anything with a date that is due a re-read, like a “Year 12”, and opens an issue on GitHub so the site doesn’t quietly go out of date.

## What building it taught me

(One paragraph: GitHub practice (branches, pull requests, checks on every change), status pages, and what “best practice” turned out to mean. Say plainly how you used AI tools to build it.)

## Related

- /programming/#this-website
- https://github.com/ThomasWCode/ThomasWCode.github.io
- /blog/
