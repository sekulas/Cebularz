# CLI Usage Examples

Initialize a new wallet:
```
npm run wallet -- init mywallet.json
```
Add an identity:
```
npm run wallet -- add-identity mywallet.json -l alpha
```
List identities:
```
npm run wallet -- list mywallet.json
```
Sign a message:
```
npm run wallet -- sign-message mywallet.json <identityId> -m 'hello world'
```
Verify a message:
```
npm run wallet -- verify-message mywallet.json <identityId> -m 'hello world' -s <signatureB64>
```

(Use `--` after `npm run wallet` to forward CLI arguments if needed.)


## Development

Type check:
```
npx tsc --noEmit
```
Run CLI directly:
```
npx tsx src/wallet/wallet-cli.ts list mywallet.json
```