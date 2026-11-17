---
'@qbit/wallet-state': patch
---

`useAddressTypeScreenLogic` reads the addresses once the page's store has its wallet, and again for another wallet or account, instead of once when the screen opens. A page opened on the Address Type screen by its address, or reloaded there, asked for the addresses of a wallet with no key, which the background refuses, and never asked again, so an HD wallet was shown too few address types. Each read starts from an empty list, so nothing of the wallet or account read before stays beside the new one's paths if the read fails, and a read that a newer one overtook sets nothing further.
