---
'@qbit/wallet-state': minor
---

A send plan paused because an input failed the check of its funding transaction (#210) reads as one of the four new pause reasons, with its own title and explanation (`send_plan_paused_input_check_*`). Continue, which checks the input again, comes first, but for an input whose transaction is gone (`input_check_not_found`), where a replan comes first.
