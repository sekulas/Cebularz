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
npm run node -- -p 4500 --miner --difficulty 5
```
### 2. Start pierwszego węzła pasywnego (bootstrap do minera)
```bash
npm run node -- -p 4501 -b http://localhost:4500 --difficulty 5
```
### 3. Start drugiego węzła pasywnego (bootstrap do minera i pierwszego węzła)
```bash
npm run node -- -p 4502 -b http://localhost:4500,http://localhost:4501 --difficulty 5
```

### 4. Start - przypięty do 4501
```bash
npm run node -- -p 4503 -b http://localhost:4501 --difficulty 5
```

### 5. Start - przypięty do 4502
```bash
npm run node -- -p 4504 -b http://localhost:4502 --difficulty 5
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

---

# Etap 3: Transakcje przekazania środków (10p)

## Zrealizowane funkcjonalności

### 1. **Tworzenie transakcji**
- Struktura transakcji: `Transaction { id, txIns[], txOuts[] }`
- **TxIn** (wejście): `{ txOutId, txOutIndex, signature, publicKey }`
- **TxOut** (wyjście): `{ address, amount }`
- **ID transakcji**: SHA-256 hash z konkatenacji wszystkich inputów i outputów
- **Podpisywanie**: Ed25519 - każde TxIn jest podpisane kluczem prywatnym nadawcy
- **UTXO model**: Unspent Transaction Outputs - każdy output może być wydany tylko raz
- **Adres**: SHA-256 hash klucza publicznego

### 2. **Transakcja Coinbase (tworzenie nowych monet)**
- **Pierwsza transakcja w każdym bloku** to coinbase
- Tworzy nowe monety z powietrza (brak prawdziwego inputu)
- Nagroda: **100 monet** za wykopany blok
- TxIn: `txOutId = ''`, `txOutIndex = blockHeight` (unikalność)
- TxOut: nagroda trafia na adres minera (`--address`)
- Walidacja coinbase: sprawdza unikalność, poprawność kwoty, strukturę

### 3. **Proof-of-Work (konsensus)**
- Worker w osobnym wątku (`miner-worker.ts`) aby nie blokować serwera HTTP
- Iteracja przez `nonce` aż hash spełni trudność (N wiodących zer)
- Blok zawiera: `height`, `timestamp`, `prevHash`, `data: { miner, transactions[] }`, `nonce`, `difficulty`, `hash`
- Każdy blok zawiera coinbase + max 2 transakcje z mempoola
- Możliwość anulowania kopania (SharedArrayBuffer) gdy pojawi się nowy blok

### 4. **Walidacja double-spending**

#### A) **W obrębie jednego bloku**:
- Funkcja `hasDuplicates()` sprawdza czy żadne TxIn nie próbuje wydać tego samego UTXO

#### B) **Między blokami**:
- **UTXO set tracking**: węzeł przechowuje aktualny zbiór niewydanych outputów
- Każda transakcja jest walidowana względem UTXO set:
  - Sprawdza czy referencyjny UTXO istnieje (`findUnspentTxOut()`)
  - Sprawdza czy adres pochodzący z klucza publicznego zgadza się z właścicielem UTXO
  - Weryfikuje podpis Ed25519
  - Sprawdza bilans: suma inputów = suma outputów
- Po zaakceptowaniu bloku:
  - Usuwa wydane UTXO z setu
  - Dodaje nowe UTXO z outputów transakcji

#### C) **Walidacja całego bloku**:
- `validateBlockTransactions()`:
  1. Waliduje coinbase (struktura, kwota, wysokość)
  2. Sprawdza duplikaty w całym bloku
  3. Waliduje każdą normalną transakcję (UTXO, podpisy, bilans)

### 5. **Obliczanie sald na kontach**
- **REST API**:
  - `GET /balance/:address` - zwraca sumę wszystkich UTXO dla adresu
  - `GET /unspent/:address` - lista wszystkich UTXO dla adresu
- **UTXO set** aktualizowany przy każdym nowym bloku:
  - Własnym (wykopany przez węzeł)
  - Obcym (otrzymany od peerów)
  - Podczas synchronizacji (przebudowa od genesis)
- Saldo = suma `amount` wszystkich UTXO należących do danego adresu

## Użycie - przykładowy scenariusz

miner1: 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb
miner2: a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3
recipient: 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9
recipient2: 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a

### 1. **Uruchom węzeł z minerem**
```bash
# Terminal 1: Węzeł-górnik z adresem do nagrody
npm run node -- --port 4500 --miner --address 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb --difficulty 6 
```

**Adres** = SHA-256(publicKey) z tożsamości w portfelu

### 2. **Poczekaj aż wykopie kilka bloków**
```bash
# Obserwuj logi:
# [node:4500] mined block height=1 hash=00a3f2... attempts=1234 ms=150
# [node:4500] Block accepted height=1 difficulty=2. UTXO set size: 1
```


### 2a. **Uruchom węzeł z 2gim minerem**
```bash
# Terminal 1: Węzeł-górnik z adresem do nagrody
npm run node -- --port 4501 -b http://localhost:4500 --miner --address a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3 --difficulty 6 
```


### 3. **Sprawdź saldo minera**
```bash
# Terminal 2: Sprawdź ile monet zarobił miner
npm run wallet -- balance http://localhost:4500 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb
npm run wallet -- balance http://localhost:4500 a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3

# POV 2giego minera
npm run wallet -- balance http://localhost:4501 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb
npm run wallet -- balance http://localhost:4501 a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3

# Wynik: Balance for address ...: 500
# (5 bloków × 100 monet = 500)
```

### 4. **Lista UTXO (opcjonalnie)**
```bash
# Zobacz szczegóły niewydanych outputów
npm run wallet -- utxos http://localhost:4500 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb
curl http://localhost:4500/unspent/5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb | jq
curl http://localhost:4500/unspent/a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3 | jq

# POV 2giego minera
curl http://localhost:4501/unspent/5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb | jq
curl http://localhost:4501/unspent/a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3 | jq
```

### 5. **Utwórz portfel odbiorcy**
```bash
# Terminal 3
npm run wallet -- init receiver-wallet.json
npm run wallet -- add-identity receiver-wallet.json --label receiver

# Zapisz adres odbiorcy (wyświetli się po add-identity):
# Address: 0df7c4bc8125afc551eb2cf7e25620ccbd00da630b768e458258e02f742051fa
```

### 6. **Wyślij transakcję**
```bash
# Terminal 2: Wyślij 49 monet z portfela minera do odbiorcy

# Etap 4 (50)
npm run wallet -- send mywallet.json 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 50 http://localhost:4500 --omit
npm run wallet -- send mywallet.json a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a 50 http://localhost:4501 --omit


# Etap 4
#4500
npm run wallet -- send mywallet.json 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a 9 http://localhost:4500 --omit
npm run wallet -- send mywallet.json 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3 6 http://localhost:4500 --omit

#4501
npm run wallet -- send mywallet.json 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 8 http://localhost:4501 --omit
npm run wallet -- send mywallet.json a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb 6 http://localhost:4501 --omit

# POV 2giego minera
npm run wallet -- send mywallet.json 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 49 http://localhost:4501 --omit
npm run wallet -- send mywallet.json a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 49 http://localhost:4501 --omit
```
> `npm run wallet -- send receiver-wallet.json 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9  5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb 12 http://localhost:4500`

### 7. **Poczekaj na wykopanie bloku z transakcją**
```bash
# Terminal 1 (logi węzła):
# [node:4500] Added tx to pool: a3f2b...
# [node:4500] mining job started (prevHeight=5, difficulty=2)
# [node:4500] mined block height=6 hash=00d4e1... (zawiera tę transakcję)
```

### 8. **Sprawdź nowe salda**
```bash
npm run wallet -- balance http://localhost:4500 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb
npm run wallet -- balance http://localhost:4500 a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3
npm run wallet -- balance http://localhost:4500 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9

#POV 2giego minera
npm run wallet -- balance http://localhost:4501 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb
npm run wallet -- balance http://localhost:4501 a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3
npm run wallet -- balance http://localhost:4501 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9
```

## Komendy CLI Wallet

# Sprawdzenie salda
npm run wallet -- balance <nodeUrl> <address>

# Lista UTXO dla adresu
npm run wallet -- unspent <nodeUrl> <address>

# Wysłanie transakcji
npm run wallet -- send \
  <plik.json> \
  <senderAddress> \
  <receiverAddress> \
  <amount> \
  <nodeUrl>
```

## Testowanie double-spending

### Scenariusz 1: Double-spending w jednym bloku (ZABLOKOWANE)
```bash
# Spróbuj wydać ten sam UTXO dwa razy w jednej transakcji
# → Walidacja wykryje duplikat TxIn
# → Blok zostanie odrzucony
```

### Scenariusz 2: Double-spending między blokami (ZABLOKOWANE)
```bash
# 1. Wyślij transakcję: Alice → Bob 50
# 2. Poczekaj aż wejdzie do bloku (UTXO wydane)
# 3. Spróbuj ponownie wydać ten sam UTXO: Alice → Charlie 50
# → Walidacja: UTXO nie istnieje w UTXO set
# → Transakcja odrzucona
```

## Mempool (Transaction Pool)

- Węzeł przechowuje transakcje oczekujące na wykopanie w `transactionPool[]`
- Dodanie transakcji: `POST /transactions`
  - Walidacja względem aktualnego UTXO set
  - Sprawdzenie czy transakcja już nie jest w zbiorze
- Mining: Górnik bierze max 2 transakcje z poola + coinbase
- Po wykopaniu bloku: usunięcie zmainowanych transakcji z poola