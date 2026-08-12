from pathlib import Path

path = Path('apps/desktop/src-tauri/src/codex_broker.rs')
text = path.read_text(encoding='utf-8')
old = '''        assert!(verify_expected_hash(Some(original), None).is_err());'''
new = '''        assert_eq!(
            verify_expected_hash(Some(original), None).expect("derive current hash"),
            Some(sha256_bytes(original))
        );'''
if text.count(old) != 1:
    raise SystemExit(f'expected exactly one old missing-hash assertion, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
Path('.github/scripts/fix_codex_sha_test.py').unlink()
