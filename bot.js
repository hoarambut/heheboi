const fs = require('fs');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { SocksClient } = require('socks'); // Đã đổi sang thư viện Socks chuyên dụng

// Đọc cấu hình từ file config.json
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const validSoils = [
    'dirt', 'coarse_dirt', 'podzol', 'grass_block', 
    'rooted_dirt', 'mycelium', 'moss_block'
];

// Hàm khởi tạo Bot độc lập
function initBot(botConfig) {
    const botName = botConfig.username;
    let bot;
    let lockedDirt = null;
    let isFarming = false;
    let smpConnected = false;
    let bypassTaskRunning = false; 
    let isLoggingIn = false; 
    let isOrdering = false;
    let isRepairing = false;
    let isPausedByItemLimit = false;

    function createBot() {
        const botOptions = { 
            host: config.server_ip,
            port: config.server_port || 25565,
            username: botName, 
            version: config.version 
        };

        // ÉP 100% KẾT NỐI QUA PROXY TCP (Khắc phục triệt để lộ IP thật)
        if (botConfig.use_proxy && botConfig.proxy) {
            botOptions.connect = (client) => {
                SocksClient.createConnection({
                    proxy: {
                        host: botConfig.proxy.host,
                        port: parseInt(botConfig.proxy.port),
                        type: 5,
                        userId: botConfig.proxy.user || null,
                        password: botConfig.proxy.pass || null
                    },
                    command: 'connect',
                    destination: {
                        host: config.server_ip,
                        port: config.server_port || 25565
                    }
                }).then(info => {
                    client.setSocket(info.socket);
                    client.emit('connect');
                }).catch(err => {
                    console.log(`[${botName} -] Lỗi kết nối Proxy: ${err.message}`);
                });
            };
            console.log(`[${botName}] Đang ép kết nối qua SOCKS5: ${botConfig.proxy.host}:${botConfig.proxy.port}`);
        } else {
            console.log(`[${botName}] Đang kết nối trực tiếp (Bằng IP thật)`);
        }

        bot = mineflayer.createBot(botOptions);

        bot.on('login', () => {
            console.log(`[${botName} +] Đã kết nối vào server.`);
            smpConnected = false; bypassTaskRunning = false; isFarming = false; 
            isLoggingIn = false; isOrdering = false; isRepairing = false;
            isPausedByItemLimit = false;
        });

        bot.on('kicked', (reason) => {
            let cleanReason = reason;
            if (typeof reason === 'object') {
                try { cleanReason = JSON.stringify(reason); } 
                catch (e) { cleanReason = String(reason); }
            }
            console.log(`[${botName} -] Bị kick khỏi server! Lý do: ${cleanReason}`);
        });

        bot.on('message', async (message) => {
            const text = message.toString();
            const textLower = text.toLowerCase();
            
            if (textLower.includes('sảnh') && !smpConnected) {
                if (!isLoggingIn) {
                    isLoggingIn = true;
                    await delay(500); 
                    bot.chat(`/dn ${config.password}`); 
                    console.log(`[${botName} *] Đã gửi lệnh đăng nhập. Đang đợi 3 giây...`);
                    
                    await delay(3000); 
                    
                    setTimeout(() => { isLoggingIn = false; }, 7000); 
                    if (!bypassTaskRunning) { bypassTaskRunning = true; runBypassLoop(); }
                }
            }
        });

        bot.on('spawn', async () => {
            if (!smpConnected && !bypassTaskRunning && !isLoggingIn) {
                setTimeout(() => {
                    if (!smpConnected && !bypassTaskRunning) {
                        bypassTaskRunning = true; runBypassLoop();
                    }
                }, 5000);
            }
        });

        bot.on('death', async () => {
            isFarming = false; smpConnected = false;
            console.log(`[${botName} !] Bot đã chết, đang kết nối lại...`);
            await delay(2000); bot.quit(); 
            setTimeout(createBot, 5000);
        });

        bot.on('end', (reason) => {
            console.log(`[${botName} -] Bot ngắt kết nối. Lý do: ${reason}`);
            isFarming = false; smpConnected = false; bypassTaskRunning = false;
            isLoggingIn = false; 
            console.log(`[${botName} *] Đang thử kết nối lại sau 5 giây...`);
            setTimeout(createBot, 5000); 
        });

        bot.on('error', (err) => console.log(`[${botName} -] Lỗi mạng/bot: ${err.message}`));
    }

    // ==========================================
    // MODULE: LOGIC BYPASS & AUTO FARM
    // ==========================================
    async function runBypassLoop() {
        while (bypassTaskRunning && !smpConnected) {
            try {
                await delay(4000); 
                let clock = bot.inventory.items().find(i => i.name.includes('clock'));
                if (clock) {
                    console.log(`[${botName} *] Đã thấy đồng hồ trong túi đồ, chờ 3 giây trước khi mở...`);
                    await delay(3000); 
                    
                    await bot.equip(clock, 'hand');
                    bot.activateItem();
                    
                    const menuWindow = await waitForWindow(12000);
                    if (menuWindow) {
                        await delay(1500); 
                        await bot.clickWindow(24, 0, 0); 
                        
                        await delay(8000); 
                        bot.chat('/shop');
                        const shopWindow = await waitForWindow(8000); 
                        if (shopWindow) {
                            bot.closeWindow(shopWindow);
                            smpConnected = true; bypassTaskRunning = false; startFarmLoop();
                            break; 
                        }
                    }
                }
            } catch (e) { await delay(3000); }
        }
    }

    function waitForWindow(timeout = 12000) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => { bot.removeAllListeners('windowOpen'); resolve(null); }, timeout);
            bot.once('windowOpen', (window) => { clearTimeout(timer); resolve(window); });
        });
    }

    async function clickItemByName(window, searchName) {
        if (!window) return false;
        for (let attempts = 0; attempts < 10; attempts++) {
            const item = window.containerItems().find(i => i.name.includes(searchName));
            if (item) {
                await bot.clickWindow(item.slot, 0, 0);
                return true;
            }
            await delay(250); 
        }
        return false;
    }

    function countItemsInArea() {
        let totalItems = 0;
        const botPos = bot.entity.position;
        for (const id in bot.entities) {
            const entity = bot.entities[id];
            if (entity && (entity.name === 'item' || entity.displayName === 'Item')) {
                const dx = Math.abs(entity.position.x - botPos.x);
                const dz = Math.abs(entity.position.z - botPos.z);
                if (dx <= 5 && dz <= 5) {
                    let stackCount = 1;
                    if (entity.metadata) {
                        for (const meta of entity.metadata) {
                            if (meta && typeof meta === 'object' && 'itemCount' in meta) {
                                stackCount = meta.itemCount;
                                break;
                            }
                        }
                    }
                    totalItems += stackCount;
                }
            }
        }
        return totalItems;
    }

    async function startFarmLoop() {
        if (isFarming) return;
        isFarming = true;
        lockDirtBlocks();

        while (isFarming) {
            if (!lockedDirt) {
                await delay(3000); lockDirtBlocks(); continue;
            }
            try {
                const currentItemCount = countItemsInArea();

                if (currentItemCount > 2000) {
                    isPausedByItemLimit = true;
                }

                if (isPausedByItemLimit) {
                    if (currentItemCount <= 96) {
                        isPausedByItemLimit = false; 
                    } else {
                        if (isTreeGrown()) {
                            await delay(1000); 
                            continue; 
                        }
                    }
                }

                await dropTrashBehind(); 
                await logicTick();
                await delay(25);
            } catch (e) { await delay(1000); }
        }
    }

    function lockDirtBlocks() {
        const playerPos = bot.entity.position.floored(); 
        const standingPos = playerPos.offset(0, -1, 0); 
        for (let yOffset = -2; yOffset <= 0; yOffset++) {
            for (let x = -4; x <= 4; x++) {
                for (let z = -4; z <= 4; z++) {
                    const checkPos = playerPos.offset(x, yOffset, z);
                    const dirtArea = [ checkPos, checkPos.offset(1, 0, 0), checkPos.offset(0, 0, 1), checkPos.offset(1, 0, 1) ];
                    if (dirtArea.some(pos => pos.equals(standingPos))) continue; 
                    if (is2x2Dirt(checkPos)) {
                        lockedDirt = dirtArea;
                        return;
                    }
                }
            }
        }
        lockedDirt = null;
    }

    function is2x2Dirt(pos) {
        const checkBlock = (p) => { const b = bot.blockAt(p); return b && validSoils.includes(b.name); };
        return checkBlock(pos) && checkBlock(pos.offset(1, 0, 0)) && checkBlock(pos.offset(0, 0, 1)) && checkBlock(pos.offset(1, 0, 1));
    }

    async function logicTick() {
        if (isOrdering || isRepairing) return;
        let axe = bot.inventory.items().find(i => i.name.includes('netherite_axe'));
        if (!axe) return;
        if (axe.durabilityUsed >= 1531) { await repairAxe(axe); return; }

        let sapling = bot.inventory.items().find(i => i.name === 'spruce_sapling');
        if (!sapling) { await orderItem('sapling'); return; }

        let boneMeal = bot.inventory.items().find(i => i.name === 'bone_meal');
        if (!boneMeal) { await orderItem('bone_meal'); return; }

        if (isTreeGrown()) { await chopTree(); } 
        else if (hasMissingSaplings()) { await plantSaplings(sapling); } 
        else { await boneMealSaplings(boneMeal); }
    }

    function isTreeGrown() {
        for (let pos of lockedDirt) {
            const block = bot.blockAt(pos.offset(0, 1, 0));
            if (block && block.name === 'spruce_log') return true;
        }
        return false;
    }

    function hasMissingSaplings() {
        for (let pos of lockedDirt) {
            const block = bot.blockAt(pos.offset(0, 1, 0));
            if (block && block.name === 'air') return true;
        }
        return false;
    }

    async function dropTrashBehind() {
        if (isOrdering || isRepairing) return;
        const trashItems = bot.inventory.items().filter(i => i.name === 'spruce_log' || i.name === 'stick');
        if (trashItems.length === 0) return;
        
        const backYaw = bot.entity.yaw + Math.PI;
        await bot.look(backYaw, 0, true).catch(() => {});
        await delay(150); 
        
        for (let item of trashItems) {
            await bot.tossStack(item).catch(() => {});
            await delay(50); 
        }
        await delay(100); 
    }

    async function plantSaplings(saplingItem) {
        await bot.equip(saplingItem, 'hand');
        for (let pos of lockedDirt) {
            const dirtBlock = bot.blockAt(pos);
            const spaceAbove = bot.blockAt(pos.offset(0, 1, 0));
            if (spaceAbove && spaceAbove.name === 'air') {
                await bot.lookAt(spaceAbove.position.offset(0.5, 0, 0.5), true).catch(() => {});
                bot.placeBlock(dirtBlock, new Vec3(0, 1, 0)).catch(() => {});
                await delay(50); 
            }
        }
    }

    async function boneMealSaplings(boneMealItem) {
        await bot.equip(boneMealItem, 'hand');
        const targetSaplingPos = lockedDirt[0].offset(0, 1, 0);
        const saplingBlock = bot.blockAt(targetSaplingPos);
        
        if (saplingBlock && saplingBlock.name === 'spruce_sapling') {
            await bot.lookAt(saplingBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => {});
            for (let i = 0; i < 4; i++) {
                const currentBlock = bot.blockAt(targetSaplingPos);
                if (!currentBlock || currentBlock.name !== 'spruce_sapling') break;
                bot.activateBlock(currentBlock, new Vec3(0, 1, 0)).catch(() => {}); 
                await delay(60);
            }
        }
    }

    async function chopTree() {
        let axe = bot.inventory.items().find(i => i.name.includes('netherite_axe'));
        if (axe) await bot.equip(axe, 'hand');

        while (true) {
            let logs = [];
            for (let pos of lockedDirt) {
                for (let y = 1; y <= 30; y++) {
                    const b = bot.blockAt(pos.offset(0, y, 0));
                    if (b && b.name === 'spruce_log') logs.push(b);
                }
            }
            if (logs.length === 0) break;
            logs.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
            const p = logs[0].position;

            await bot.lookAt(p.offset(0.5, 0.5, 0.5), true).catch(() => {});
            bot._client.write('block_dig', { status: 0, location: { x: p.x, y: p.y, z: p.z }, face: 1, sequence: 0 });
            await delay(550); 
            bot._client.write('block_dig', { status: 2, location: { x: p.x, y: p.y, z: p.z }, face: 1, sequence: 0 });
        }
    }

    async function orderItem(type) {
        isOrdering = true; 
        const footPos = bot.entity.position.offset(0, -1, 0);
        await bot.lookAt(footPos, true).catch(() => {});
        await delay(150); 
        bot.chat('/order NotApple');
        
        try {
            const gui1 = await waitForWindow(12000);
            if (!gui1) { isOrdering = false; return; }
            await delay(200); 
            const click1 = await clickItemByName(gui1, 'chest');
            if (!click1) { bot.closeWindow(gui1); isOrdering = false; return; }

            const gui2 = await waitForWindow(12000);
            if (!gui2) { bot.closeWindow(gui1); isOrdering = false; return; }
            await delay(200); 
            const click2 = await clickItemByName(gui2, type === 'sapling' ? 'spruce_sapling' : 'bone_meal');
            if (!click2) { bot.closeWindow(gui2); isOrdering = false; return; }

            const gui3 = await waitForWindow(12000);
            if (!gui3) { bot.closeWindow(gui2); isOrdering = false; return; }
            await delay(300); 
            
            await bot.lookAt(footPos, true).catch(() => {});
            await delay(200);
            
            await bot.clickWindow(16, 0, 0); 
            await delay(500); 
            await bot.clickWindow(17, 0, 0);
            
            await delay(1200); 
            bot.closeWindow(gui3);
            await delay(2000); 
        } catch(e) {}
        isOrdering = false; 
    }

    async function repairAxe(axe) {
        isRepairing = true;
        bot.chat('/shop');
        try {
            const gui1 = await waitForWindow(12000);
            if (!gui1) { isRepairing = false; return; }
            await delay(200); 
            const click1 = await clickItemByName(gui1, 'totem'); 
            if (!click1) { bot.closeWindow(gui1); isRepairing = false; return; }

            const gui2 = await waitForWindow(12000);
            if (!gui2) { bot.closeWindow(gui1); isRepairing = false; return; }
            await delay(200); 
            const click2 = await clickItemByName(gui2, 'experience_bottle'); 
            if (!click2) { bot.closeWindow(gui2); isRepairing = false; return; }

            const gui3 = await waitForWindow(12000);
            if (gui3) {
                await delay(400); await bot.clickWindow(17, 0, 0); await delay(300);
                for (let i = 0; i < 3; i++) { await bot.clickWindow(23, 0, 0); await delay(200); }
                bot.closeWindow(gui3);
            }
            let expBottle = bot.inventory.items().find(i => i.name === 'experience_bottle');
            while (expBottle !== undefined) {
                await bot.equip(expBottle, 'off-hand');
                bot.activateItem(true); await delay(60);
                let checkAxe = bot.inventory.items().find(i => i.name.includes('netherite_axe'));
                if (checkAxe && checkAxe.durabilityUsed === 0) break;
                expBottle = bot.inventory.items().find(i => i.name === 'experience_bottle');
            }
        } catch(e) {}
        isRepairing = false; 
    }

    createBot();
}

// ==========================================
// TRÌNH QUẢN LÝ ĐA BOT
// ==========================================
async function startAllBots() {
    console.log(`[SYSTEM] Tìm thấy ${config.bots.length} tài khoản. Bắt đầu nạp...`);
    
    for (const botConfig of config.bots) {
        console.log(`[SYSTEM] Đang cấu hình bot: ${botConfig.username}...`);
        initBot(botConfig);
        
        await delay(config.join_delay_ms || 6000); 
    }
}

startAllBots();
