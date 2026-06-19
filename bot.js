const fs = require('fs');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

// Đọc cấu hình từ file config.json
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const validSoils = [
    'dirt', 'coarse_dirt', 'podzol', 'grass_block', 
    'rooted_dirt', 'mycelium', 'moss_block'
];

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
    let bonemealStuckCounter = 0; // Biến chống kẹt từ Java

    function createBot() {
        const botOptions = { 
            host: config.server_ip,
            port: config.server_port || 25565,
            username: botName, 
            version: config.version 
        };

        console.log(`[${botName}] Đang kết nối trực tiếp (Đã loại bỏ Proxy để tối ưu).`);

        bot = mineflayer.createBot(botOptions);
        bot.setMaxListeners(0); 

        bot.on('login', () => {
            console.log(`[${botName} +] Đã kết nối vào server.`);
            smpConnected = false; bypassTaskRunning = false; isFarming = false; 
            isLoggingIn = false; isOrdering = false; isRepairing = false;
            isPausedByItemLimit = false;
            bonemealStuckCounter = 0;
        });

        bot.on('kicked', (reason) => {
            let cleanReason = reason;
            if (typeof reason === 'object') {
                try { cleanReason = JSON.stringify(reason); } 
                catch (e) { cleanReason = String(reason); }
            }
            console.log(`[${botName} -] Bị kick khỏi server! Lý do: ${cleanReason}`);
        });

        // Không in log chat ra console, chỉ kiểm tra lệnh sảnh
        bot.on('message', async (message) => {
            const text = message.toString().toLowerCase();
            if (text.includes('sảnh') && text.includes('đăng nhập bằng lệnh') && !smpConnected) {
                if (!isLoggingIn) {
                    isLoggingIn = true;
                    await delay(500); 
                    bot.chat(`/dn ${config.password}`); 
                    console.log(`[${botName} *] Đã gửi lệnh đăng nhập. Đang đợi...`);
                    
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
            console.log(`[${botName} -] Ngắt kết nối. Thử lại sau 5 giây...`);
            isFarming = false; smpConnected = false; bypassTaskRunning = false;
            isLoggingIn = false; 
            setTimeout(createBot, 5000); 
        });

        bot.on('error', (err) => console.log(`[${botName} -] Lỗi mạng/bot: ${err.message}`));
    }

    async function runBypassLoop() {
        while (bypassTaskRunning && !smpConnected) {
            try {
                await delay(4000); 
                let clock = bot.inventory.items().find(i => i.name.includes('clock'));
                if (clock) {
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
                            console.log(`[${botName} +] Bypass thành công. Bắt đầu Farm.`);
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

    // Cơ chế Retry (Max 3 lần) từ Java
    async function clickItemByName(window, searchName, retries = 3) {
        if (!window) return false;
        for (let attempts = 0; attempts < retries * 5; attempts++) {
            const item = window.containerItems().find(i => i.name.includes(searchName));
            if (item) {
                await bot.clickWindow(item.slot, 0, 0);
                return true;
            }
            await delay(500); 
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

    async function strictEquip(matchStr, destination, isExact = false) {
        let item = bot.inventory.items().find(i => isExact ? i.name === matchStr : i.name.includes(matchStr));
        if (!item) return false;
        try {
            if (bot.heldItem && (isExact ? bot.heldItem.name === matchStr : bot.heldItem.name.includes(matchStr))) return true;
            await bot.equip(item, destination);
            await delay(250); // Độ trễ nhẹ chống lỗi Desync
            return true;
        } catch (err) {
            return false;
        }
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

                // Logic Hopper hút đồ từ Java
                if (currentItemCount > 2000 && isTreeGrown()) isPausedByItemLimit = true;
                
                if (isPausedByItemLimit) {
                    if (currentItemCount <= 96) {
                        isPausedByItemLimit = false; 
                    } else {
                        await delay(1000); 
                        continue; 
                    }
                }

                if (!isOrdering && !isRepairing && !bot.currentWindow) {
                    await dropTrashBehind(); 
                }
                
                await logicTick();
                await delay(50);
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

    function getMissingSaplingPositions() {
        let missing = [];
        for (let pos of lockedDirt) {
            const blockAbove = bot.blockAt(pos.offset(0, 1, 0));
            if (blockAbove && blockAbove.name !== 'spruce_log' && blockAbove.name !== 'spruce_sapling') {
                missing.push(pos);
            }
        }
        return missing;
    }

    function isTreeGrown() {
        for (let pos of lockedDirt) {
            const block = bot.blockAt(pos.offset(0, 1, 0));
            if (block && block.name === 'spruce_log') return true;
        }
        return false;
    }

    async function logicTick() {
        if (isOrdering || isRepairing || bot.currentWindow) return;
        
        let axe = bot.inventory.items().find(i => i.name.includes('netherite_axe'));
        if (!axe) return;
        
        // Ngưỡng 1531 tương đương với việc mất đi khoảng 500 độ bền
        if (axe.durabilityUsed >= 1531) { await repairAxe(); return; }

        let sapling = bot.inventory.items().find(i => i.name === 'spruce_sapling');
        if (!sapling) { await orderItem('sapling'); return; }

        let boneMeal = bot.inventory.items().find(i => i.name === 'bone_meal');
        if (!boneMeal) { await orderItem('bone_meal'); return; }

        if (isTreeGrown()) { 
            await chopTree(); 
            bonemealStuckCounter = 0; // Reset chống kẹt
        } else {
            let missingPositions = getMissingSaplingPositions();
            if (missingPositions.length > 0) {
                await plantSaplings(missingPositions); 
                bonemealStuckCounter = 0;
            } else {
                await boneMealSaplings(); 
            }
        }
    }

    async function dropTrashBehind() {
        if (isOrdering || isRepairing || bot.currentWindow) return;
        const trashItems = bot.inventory.items().filter(i => i.name === 'spruce_log' || i.name === 'stick' || i.name === 'spruce_leaves');
        if (trashItems.length === 0) return;
        
        const originalYaw = bot.entity.yaw;
        const backYaw = originalYaw + Math.PI;
        
        await bot.look(backYaw, 0, true).catch(() => {});
        await delay(150); 
        
        for (let item of trashItems) {
            if (isOrdering || isRepairing || bot.currentWindow) break;
            await bot.tossStack(item).catch(() => {});
            await delay(50); 
        }
        
        await bot.look(originalYaw, 0, true).catch(() => {});
        await delay(100); 
    }

    async function plantSaplings(missingPositions) {
        if (isOrdering || isRepairing || bot.currentWindow) return;
        
        for (let pos of missingPositions) {
            if (isOrdering || isRepairing || bot.currentWindow) return;
            
            const isEquipped = await strictEquip('spruce_sapling', 'hand', true);
            if (!isEquipped) break; 

            const dirtBlock = bot.blockAt(pos);
            const spaceAbove = bot.blockAt(pos.offset(0, 1, 0));
            
            if (spaceAbove && spaceAbove.name !== 'spruce_log' && spaceAbove.name !== 'spruce_sapling') {
                await bot.lookAt(spaceAbove.position.offset(0.5, 0, 0.5), true).catch(() => {});
                await bot.placeBlock(dirtBlock, new Vec3(0, 1, 0)).catch(() => {});
                await delay(150); 
            }
        }
    }

    async function boneMealSaplings() {
        if (isOrdering || isRepairing || bot.currentWindow) return;
        
        const targetSaplingPos = lockedDirt[0].offset(0, 1, 0);
        
        for (let i = 0; i < 4; i++) {
            if (isOrdering || isRepairing || bot.currentWindow) return;
            
            const isEquipped = await strictEquip('bone_meal', 'hand', true);
            if (!isEquipped) break;

            const saplingBlock = bot.blockAt(targetSaplingPos);
            if (!saplingBlock || saplingBlock.name !== 'spruce_sapling') break;

            await bot.lookAt(saplingBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => {});
            bot.activateBlock(saplingBlock, new Vec3(0, 1, 0)).catch(() => {}); 
            await delay(100);
            
            bonemealStuckCounter++;
        }

        // Logic nhảy khi kẹt từ Java
        if (bonemealStuckCounter >= 40) {
            if (bot.entity.onGround) {
                bot.setControlState('jump', true);
                await delay(100);
                bot.setControlState('jump', false);
            }
            bonemealStuckCounter = 0;
        }
    }

    async function chopTree() {
        if (isOrdering || isRepairing || bot.currentWindow) return;

        while (true) {
            if (isOrdering || isRepairing || bot.currentWindow) break;
            
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

            const isEquipped = await strictEquip('netherite_axe', 'hand', false);
            if (!isEquipped) break;

            await bot.lookAt(p.offset(0.5, 0.5, 0.5), true).catch(() => {});
            bot._client.write('block_dig', { status: 0, location: { x: p.x, y: p.y, z: p.z }, face: 1, sequence: 0 });
            await delay(550); 
            bot._client.write('block_dig', { status: 2, location: { x: p.x, y: p.y, z: p.z }, face: 1, sequence: 0 });
        }
        
        await bot.look(bot.entity.yaw, 0, true).catch(() => {});
    }

    async function orderItem(type) {
        isOrdering = true; 
        const originalYaw = bot.entity.yaw;
        
        // Nhìn thẳng xuống đất (Pitch 90 độ giống Java)
        await bot.look(originalYaw, -Math.PI / 2, true).catch(() => {});
        await delay(150); 
        bot.chat('/order NotApple');
        
        try {
            const gui1 = await waitForWindow(12000);
            if (!gui1) { isOrdering = false; return; }
            await delay(300); 
            const click1 = await clickItemByName(gui1, 'chest');
            if (!click1) { bot.closeWindow(gui1); isOrdering = false; return; }

            const gui2 = await waitForWindow(12000);
            if (!gui2) { bot.closeWindow(gui1); isOrdering = false; return; }
            await delay(300); 
            const click2 = await clickItemByName(gui2, type === 'sapling' ? 'spruce_sapling' : 'bone_meal');
            if (!click2) { bot.closeWindow(gui2); isOrdering = false; return; }

            const gui3 = await waitForWindow(12000);
            if (!gui3) { bot.closeWindow(gui2); isOrdering = false; return; }
            await delay(400); 
            
            // Ép nhìn xuống đất lại lần nữa để tránh mở hụt rương
            await bot.look(originalYaw, -Math.PI / 2, true).catch(() => {});
            await delay(200);
            
            await bot.clickWindow(16, 0, 0); 
            await delay(500); 
            await bot.clickWindow(16, 0, 0); // Java ghi click 2 lần cùng 1 slot (SLOT17_1 và SLOT17_2 index 16)
            
            await delay(1500); 
            bot.closeWindow(gui3);
            await delay(2500); 
        } catch(e) {}
        
        await bot.look(originalYaw, 0, true).catch(() => {});
        isOrdering = false; 
    }

    async function repairAxe() {
        isRepairing = true;
        const originalYaw = bot.entity.yaw;

        // Cầm chặt rìu trước khi mở shop
        await strictEquip('netherite_axe', 'hand', false);

        // Nhìn thẳng xuống đất
        await bot.look(originalYaw, -Math.PI / 2, true).catch(() => {});
        bot.chat('/shop');
        try {
            const gui1 = await waitForWindow(12000);
            if (!gui1) { isRepairing = false; return; }
            await delay(300); 
            const click1 = await clickItemByName(gui1, 'totem'); 
            if (!click1) { bot.closeWindow(gui1); isRepairing = false; return; }

            const gui2 = await waitForWindow(12000);
            if (!gui2) { bot.closeWindow(gui1); isRepairing = false; return; }
            await delay(300); 
            const click2 = await clickItemByName(gui2, 'experience_bottle'); 
            if (!click2) { bot.closeWindow(gui2); isRepairing = false; return; }

            const gui3 = await waitForWindow(12000);
            if (gui3) {
                await delay(500); 
                await bot.clickWindow(17, 0, 0); // Click slot 18 (index 17)
                await delay(300);
                for (let i = 0; i < 3; i++) { 
                    await bot.clickWindow(23, 0, 0); // Click slot 24 (index 23) x3
                    await delay(250); 
                }
                bot.closeWindow(gui3);
            }
            
            await delay(1000);
            
            let expBottle = bot.inventory.items().find(i => i.name === 'experience_bottle');
            while (expBottle !== undefined) {
                // Ép bot cầm bình kinh nghiệm tay trái, rìu tay phải
                await strictEquip('netherite_axe', 'hand', false);
                await strictEquip('experience_bottle', 'off-hand', true);
                await delay(150);

                bot.activateItem(true); // true = ném bằng off-hand
                await delay(100);

                let checkAxe = bot.inventory.items().find(i => i.name.includes('netherite_axe'));
                if (checkAxe && checkAxe.durabilityUsed === 0) break;
                
                expBottle = bot.inventory.items().find(i => i.name === 'experience_bottle');
            }
        } catch(e) {}
        
        await bot.look(originalYaw, 0, true).catch(() => {});
        isRepairing = false; 
    }

    createBot();
}

async function startAllBots() {
    console.log(`[SYSTEM] Tìm thấy ${config.bots.length} tài khoản. Bắt đầu nạp...`);
    
    for (const botConfig of config.bots) {
        console.log(`[SYSTEM] Đang cấu hình bot: ${botConfig.username}...`);
        initBot(botConfig);
        
        await delay(config.join_delay_ms || 6000); 
    }
}

startAllBots();
