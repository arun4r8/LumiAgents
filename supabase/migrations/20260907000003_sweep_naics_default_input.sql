-- ============================================================================
-- Set the sweep's NAICS list on the SCHEDULE, and drop 541330
--
-- WHY THE SCHEDULE AND NOT THE CODE
--   `default_input` was '{}', so the sweep has always run on the code default and
--   the list could only be changed by a deploy. A NAICS list is a business tuning
--   knob -- BD will want to try codes -- and it belongs where it can be edited.
--   The code default stays as the fallback for a manual run with no input.
--
-- WHY 541330 GOES (#205)
--   The first sweep whose NAICS filter actually reached SAM (#208 -- the query had
--   been sending `naicsCode`, which SAM ignores, so nothing was filtered) reported:
--
--     541330  Engineering Services       91   <- 57% of the entire match set
--     541519  Other Computer Related     37
--     541512  Computer Systems Design    19
--     541511  Custom Programming         14
--                                       ---
--                                       161
--
--   541330 is 57% of everything the sweep sees and, by the stored fit data, the
--   weakest configured code: average fit 5.3 and not one row at 7 or above. It is
--   Engineering Services -- overwhelmingly civil and construction. It was not
--   adding recall, it was adding 91 notices a day for the model to reject.
--
-- WHY 518210 AND 541611 COME IN
--   Not a guess. Lumiture's own Census past-performance write-up lists its SINs as
--   54151S (main), 518210C and 541611 -- work already delivered under both, and
--   neither was being searched.
--
-- WHAT IS DELIBERATELY NOT DONE
--   513210 (Software Publishers) and 541715 (R&D) looked strong in the stored data
--   (28 rows at avg 6.7, and 9 at 6.3). That data is not evidence: those rows
--   arrived while NO NAICS filter was applied, and every fit score in the table was
--   computed without the notice body (#219). Both are worth revisiting once a week
--   of filtered, body-scored sweeps exists. Adding them now would be guessing with
--   extra steps.
--
--   Each code is a separate paged SAM query, so the list length is also a
--   subrequest cost -- see runtime/tests/unit/sweep-subrequest-budget.test.ts.
-- ============================================================================

UPDATE orchestration.schedules
SET default_input = jsonb_build_object(
      'naicsCodes', jsonb_build_array('541512', '541511', '541519', '518210', '541611')
    ),
    updated_at = now()
WHERE orchestration_name = 'beady/opportunity-sweep';
