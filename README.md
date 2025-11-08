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

---

# Etap 2: Prosty łańcuch bloków + Proof-of-Work

## Zrealizowane funkcjonalności
- Jeden górnik (węzeł z flagą `--miner`) kopiący ciągłe bloki.
- Struktura bloku: `height`, `timestamp`, `prevHash`, `data { miner, transactions[] }`, `nonce`, `difficulty`, `hash`.
- Proof-of-Work z trudnością: hash bloku musi zaczynać się od `difficulty` zer w zapisie hex.
- Genesis blok deterministyczny (height=0, difficulty=0).
- Tworzenie nowych bloków poprzez iterację nonce aż hash spełni warunek trudności.
- Protokół wymiany:
  - `GET /blocks` – pobranie pełnego lokalnego łańcucha.
  - `GET /blocks/latest` – najnowszy blok + wysokość + trudność.
  - `POST /blocks/new` – propagacja nowego bloku (walidacja wysokości, prevHash, hash, difficulty).
- Walidacja przy synchronizacji pełnego łańcucha (`validateChain`).
- Automatyczna synchronizacja przy rejestracji peera (`/register`).
- Ping/pong utrzymujący listę aktywnych peerów.
- Możliwość konfiguracji trudności flagą CLI `--difficulty` (zakres testowy 0..8).
- Usunięto `mineInterval`; kopanie jest ciągłe (następny blok po poprzednim). 

## Uruchomienie (przykład: 1 górnik + 2 węzły pasywne)
### 1. Start minera
```bash
npm run node -- -p 4500 --miner --difficulty 6
```
### 2. Start pierwszego węzła pasywnego (bootstrap do minera)
```bash
npm run node -- -p 4501 -b http://localhost:4500 --difficulty 6
```
### 3. Start drugiego węzła pasywnego (bootstrap do minera i pierwszego węzła)
```bash
npm run node -- -p 4502 -b http://localhost:4500,http://localhost:4501 --difficulty 6
```

### 4. Start - przypięty do 4501
```bash
npm run node -- -p 4503 -b http://localhost:4501 --difficulty 6
```

### 5. Start - przypięty do 4502
```bash
npm run node -- -p 4504 -b http://localhost:4502 --difficulty 6
```

## Podgląd stanu (inne okno terminala)
### Najnowszy blok na każdym węźle
```bash
curl -s http://localhost:4500/blocks/latest | jq
curl -s http://localhost:4501/blocks/latest | jq
curl -s http://localhost:4502/blocks/latest | jq
```
### Peery węzła minera
```bash
curl -s http://localhost:4500/peers | jq
```

## Uwagi
- Wszystkie węzły muszą uruchamiać się z tą samą wartością `--difficulty`, inaczej odrzucą nawzajem swoje bloki.
- Zwiększenie trudności (np. 3,4) znacząco spowalnia kopanie i zużywa więcej CPU.
- Przy `difficulty=0` PoW jest wyłączone (hash może zaczynać się od dowolnego znaku), bloki powstają bardzo szybko.
- Obecnie brak mechanizmu zatrzymania kopania – wyłączenie górnika = zakończenie procesu.
