# Family care semantics implementation plan

Status: Complete
Date: 2026-08-09

1. [x] Merge `1974de1d` into the `09d435be` authority line and prove the merged
   frontend baseline.
2. [x] Add the B-owned `family_delivery` discriminator and record invariants; split
   ordinary delivery naming/risk from alarm semantics.
3. [x] Version and update Python, frontend and Relay exact contracts.
4. [x] Make the scripted concrete-need path carry actual elder text without
   changing the generic help response.
5. [x] Render judgment, notification, action-card and alarm timeline events as
   distinct presentations of the same authoritative decision.
6. [x] Update ADR/interface documentation, run the full verification matrix and
   commit the result.
