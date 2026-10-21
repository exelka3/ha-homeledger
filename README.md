# Homeledger — репозиторий аддона для Home Assistant

![Homeledger](homeledger/logo.png)

Домашний бюджет внутри Home Assistant. Описание возможностей — в
[homeledger/DOCS.md](homeledger/DOCS.md).

## Установка

### Через репозиторий на GitHub

1. В Home Assistant: **Настройки → Дополнения → Магазин дополнений → ⋮ → Репозитории**.
2. Добавьте адрес `https://github.com/exelka3/ha-homeledger`.
3. Найдите **Homeledger**, нажмите **Установить**, затем **Запустить**.
   Включите «Показывать на боковой панели».

### Локально, без GitHub

1. Скопируйте папку `homeledger` в каталог `/addons` Home Assistant
   (например, через аддоны *Samba share* или *Advanced SSH & Web Terminal*),
   чтобы получилось `/addons/homeledger/config.yaml`.
2. **Настройки → Дополнения → Магазин дополнений → ⋮ → Проверить обновления**.
3. Появится раздел **Локальные дополнения** → **Homeledger** → **Установить**.

Сборка Docker-образа выполняется на самом Home Assistant и занимает 1–3 минуты.

## Разработка

```bash
python3 homeledger/app/server.py          # http://localhost:8099
python3 homeledger/app/seed_demo.py       # демо-данные в homeledger/data/db.json
```

Для проверки интеграции вне HA задайте `HA_URL` и `HA_TOKEN`
(долгосрочный токен доступа).
