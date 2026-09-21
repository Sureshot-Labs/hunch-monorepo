# Pinned tokenizer assets

These are tokenizer data only, not model weights. Runtime reads the local files and
checks SHA-256; it never downloads files. `@huggingface/tokenizers` is pinned in the
workspace lockfile.

- E5: `intfloat/e5-large-v2`, revision
  `f169b11e22de13617baa190a028a32f3493550b6`, MIT-licensed model.
  Source: https://huggingface.co/intfloat/e5-large-v2/tree/f169b11e22de13617baa190a028a32f3493550b6
- Qwen: `Qwen/Qwen3-Embedding-8B`, revision
  `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af`, Apache-2.0.
  Source: https://huggingface.co/Qwen/Qwen3-Embedding-8B/tree/1d8ad4ca9b3dd8059ad90a75d4983776a23d44af

The files contain `tokenizer.json` and `tokenizer_config.json`, renamed with
an `e5-` or `qwen-` prefix and `.asset` extension to keep formatters from rewriting
the pinned bytes. A final LF is added to tokenizer files (which lacked one); no
JSON values are changed. Their hashes are recorded in `src/text.ts`. Changing the
assets or normalization/prefix behavior requires a new embedding adapter version.
