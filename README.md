# CLI Wallet Usage Examples
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
(Use `--` after `npm run wallet` to forward CLI arguments.)


# CLI Node Usage Examples
Terminal 1:
```
npm run node -- -p 4000
```
Terminal 2:
```
npm run node -- -p 4001 -b http://localhost:4000
```
Terminal 3:
```
npm run node -- -p 4002 -b http://localhost:4000,http://localhost:4001
```