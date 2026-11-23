# StrykerJS's default timeout per mutant

- **Status:** accepted, decided by the owner on 2026-11-23, as part of the trial of StrykerJS's Vitest runner.
- **Practice departed from:** a timeout per mutant of about 10 to 20 times the measured time of its tests.
- **Value not at stake:** correctness and the machine's use. StrykerJS's defaults (`timeoutMS` 5000 and
  `timeoutFactor` 1.5) give each mutant 1.5 times what its tests took in the dry run plus 5 seconds. The page's
  tests take milliseconds, so a mutant that slows them down under load still finishes far inside that, and none is
  counted as killed by a timeout it did not earn. What the longer limit costs is a hung mutant holding its worker for
  about 5 seconds, which, on at most half the cores, leaves the machine usable.

Revisit if a round shows many timeouts, which would make those 5 seconds add up, or if StrykerJS changes its
defaults.
