# Third-party notices

## Bundled phishing-policy seed data

Qbit Wallet's `qbit-static-v1` denylist was derived from the `blacklist` field in
`unisat-wallet/phishing-detect` at commit
`62078d24175a1af12715e5acaa2b8cbf77abda03`, file `phishing_sites.json`, Git blob
`0f2812cb5f7c5ae1b188daa7ba7660b9ffd860fb`.

The source contained 30 entries. Qbit normalized two path-bearing entries to
hostnames and removed one duplicate, resulting in 29 unique hostnames. The
source fuzzy and whitelist fields are not included. Qbit owns the review,
release, and update policy for the bundled snapshot. Updates require a reviewed
source change and ship only with an extension release.

The source repository provides the following license:

> The MIT License (MIT)
>
> Copyright (c) 2022-present UniSat
>
> Brand name and logo of UniSat is copyright reserved. You can not use brand
> name or logo of UniSat for your re-publish software.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
