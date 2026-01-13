
miner1 (4500): 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb
miner2 (4501): a7d532a4ce1cc4c06d674665cb0bceb3ceda41c4ebdf1085e59901c2573528e3
recipient: 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9
recipient2: 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a

(łańcuch 4501 jest przegrany)

1. Uruchamiamy 4500 i 4501
2. Kopią kilka bloków (min 100 saldo każdego minera)
3. W tym czasie robimy transakcję z 4500 na 50 do recipient
4. W tym czasie robimy transakcję z 4501 na 50 do recipient2

(różne peery)
```bash
npm run wallet -- send mywallet.json 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 50 http://localhost:4500 --omit
npm run wallet -- send mywallet.json 5951120453f0923eb8bb8f4d65c970eed814d4491e5c427793aa9419f8637ecb 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a 50 http://localhost:4501 --omit
```

5. Niech się wykopie i zsynchronizuje
6. Salda powinny być - minery x00, recipient 50, recipient2 50
7. Derejestrujemy peery
8. Kopanie...
9. W 4500 robimy transakcję na 9 z recipient do recipient2
10. W 4501 robimy transakcję na 8 z recipient2 do recipient

```bash
npm run wallet -- send mywallet.json 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a 9 http://localhost:4500 --omit
npm run wallet -- send mywallet.json 3c516ab9d27f4f8edee97577d19e05c518c4cf6f0921a2f6e1a44d383bf36d9a 189ff8dd91f6692d04c074acb37fc97abb01d47888bd5fe50b0585fa5fdec3e9 8 http://localhost:4501 --omit
```

11. Czekamy aż w 4500 i 4501 wykopią się transakcje
12. Wstrzymujemy kopanie w 4501
13. Kopanie w 4500...
14. Wznawiamy kopanie w 4501
15. Rejestrujemy peery
16. Saldo powinno od razu po reorgu wskazywać: recipient=41, recipient2=59
17. Kopanie...
18. Po requeue i wykopaniu transakcji na 8 z 4501 salda powinny być: recipient=49, recipient2=51
