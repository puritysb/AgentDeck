# Pocket Daily learning data — source and modification notice

The `jp-n3-ko` dataset is an adapted subset of **OpenJLPT**, pinned at commit
`c42fd9fa3777bfc1775446f7c418d549dfd6e4cf`. OpenJLPT distributes its dataset
under **CC BY-SA 4.0** and records the following upstream sources:

- **JMdict / EDICT and KANJIDIC2**, Electronic Dictionary Research and
  Development Group (EDRDG): vocabulary and kanji readings and English
  glosses; CC BY-SA 4.0. <https://www.edrdg.org/>
- **Jonathan Waller's JLPT Resources**: unofficial N5–N1 level assignments;
  CC BY according to the pinned OpenJLPT notice.
  <https://www.tanos.co.uk/jlpt/>
- **Tatoeba**: Japanese example sentences; CC BY 2.0 FR.
  <https://tatoeba.org/>

OpenJLPT and its full notice are available at
<https://github.com/evanclan/OpenJLPT/tree/c42fd9fa3777bfc1775446f7c418d549dfd6e4cf>.

Pocket Daily modifications are distributed under **CC BY-SA 4.0**:

- retained the cumulative N5, N4, and N3 kanji subset (612 unique characters);
- selected one compact representative word and Japanese example per character;
- added Korean kanji glosses, word meanings, and example translations;
- normalized the data into the fixed-record PDLP format for bounded SD reads.

The Korean adaptations are by Pocket Daily contributors. Automated assistance
was used to draft translations; field alignment, required Korean text, record
counts, byte bounds, source pinning, and package checksums are validated before
distribution. Corrections remain welcome and must be shared under CC BY-SA 4.0.

The JLPT organization does not publish an official current vocabulary or kanji
list. The level labels are therefore **unofficial N3-oriented study curation**,
not a claim about the undisclosed contents of a particular examination.
