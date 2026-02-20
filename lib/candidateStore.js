/**
 * Candidate Store - Simple file-based queue for pending metabolisms
 * 
 * Design principles:
 * - Zero runtime latency for candidate writing (synchronous file append)
 * - Atomic reads for processing (move file to processing, then delete on success)
 * - Size-bounded (prune old candidates when over limit)
 */

const fs = require('fs');
const path = require('path');

class CandidateStore {
    constructor(config, dataDir) {
        this.dataDir = dataDir;
        this.candidatesDir = path.join(dataDir, config.storage?.candidatesDir || 'candidates');
        this.processedDir = path.join(dataDir, config.storage?.processedDir || 'processed');
        this.maxPending = config.processing?.maxPendingCandidates || 50;
        
        this._ensureDirs();
    }
    
    _ensureDirs() {
        if (!fs.existsSync(this.candidatesDir)) {
            fs.mkdirSync(this.candidatesDir, { recursive: true });
        }
        if (!fs.existsSync(this.processedDir)) {
            fs.mkdirSync(this.processedDir, { recursive: true });
        }
    }
    
    /**
     * Write a candidate for later processing.
     * Synchronous, fast (<5ms typically).
     * 
     * @param {Object} candidate - { timestamp, userId, messages, entropy, metadata }
     * @returns {string} candidate ID
     */
    write(candidate) {
        const id = `cand_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const filepath = path.join(this.candidatesDir, `${id}.json`);
        
        const data = {
            id,
            timestamp: candidate.timestamp || new Date().toISOString(),
            userId: candidate.userId || 'unknown',
            entropy: candidate.entropy || 0,
            messages: candidate.messages || [],
            metadata: candidate.metadata || {},
            written: Date.now()
        };
        
        // Synchronous write for speed
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        
        // Prune if over limit
        this._pruneIfNeeded();
        
        return id;
    }
    
    /**
     * Get pending candidates up to batchSize.
     * Returns candidates sorted by entropy (highest first) for priority processing.
     * 
     * @param {number} batchSize - Maximum candidates to return
     * @returns {Array<Object>} candidates with their file paths
     */
    getPending(batchSize = 3) {
        const files = fs.readdirSync(this.candidatesDir)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                filepath: path.join(this.candidatesDir, f),
                filename: f
            }));
        
        if (files.length === 0) return [];
        
        // Read and parse, then sort by entropy (highest first)
        const candidates = files.map(f => {
            try {
                const content = fs.readFileSync(f.filepath, 'utf8');
                return { ...JSON.parse(content), filepath: f.filepath };
            } catch (e) {
                return null;
            }
        }).filter(Boolean);
        
        // Sort by entropy descending
        candidates.sort((a, b) => (b.entropy || 0) - (a.entropy || 0));
        
        return candidates.slice(0, batchSize);
    }
    
    /**
     * Mark a candidate as processed (move to processed dir).
     * 
     * @param {string} candidateId - The candidate ID
     * @param {Object} result - Optional processing result to attach
     */
    markProcessed(candidateId, result = {}) {
        const sourcePath = path.join(this.candidatesDir, `${candidateId}.json`);
        const destPath = path.join(this.processedDir, `${candidateId}.json`);
        
        if (fs.existsSync(sourcePath)) {
            // Attach result if provided
            if (Object.keys(result).length > 0) {
                try {
                    const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
                    data.processed = Date.now();
                    data.result = result;
                    fs.writeFileSync(sourcePath, JSON.stringify(data, null, 2));
                } catch (e) {
                    // Best effort
                }
            }
            
            // Move to processed
            try {
                fs.renameSync(sourcePath, destPath);
            } catch (e) {
                // If rename fails (cross-device), copy and delete
                fs.copyFileSync(sourcePath, destPath);
                fs.unlinkSync(sourcePath);
            }
        }
    }
    
    /**
     * Remove a candidate entirely (no processing result).
     * 
     * @param {string} candidateId - The candidate ID
     */
    remove(candidateId) {
        const filepath = path.join(this.candidatesDir, `${candidateId}.json`);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    }
    
    /**
     * Get counts for monitoring.
     */
    getStats() {
        const pending = fs.readdirSync(this.candidatesDir)
            .filter(f => f.endsWith('.json')).length;
        const processed = fs.readdirSync(this.processedDir)
            .filter(f => f.endsWith('.json')).length;
        return { pending, processed };
    }
    
    /**
     * Prune oldest candidates if over limit.
     */
    _pruneIfNeeded() {
        const files = fs.readdirSync(this.candidatesDir)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                filename: f,
                filepath: path.join(this.candidatesDir, f),
                mtime: fs.statSync(path.join(this.candidatesDir, f)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime); // Newest first
        
        if (files.length > this.maxPending) {
            const toRemove = files.slice(this.maxPending);
            for (const f of toRemove) {
                try {
                    fs.unlinkSync(f.filepath);
                } catch (e) {
                    // Best effort
                }
            }
        }
    }
    
    /**
     * Clean up old processed files (run occasionally).
     */
    cleanProcessed(olderThanDays = 7) {
        const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
        const files = fs.readdirSync(this.processedDir)
            .filter(f => f.endsWith('.json'));
        
        let removed = 0;
        for (const f of files) {
            const filepath = path.join(this.processedDir, f);
            try {
                const stat = fs.statSync(filepath);
                if (stat.mtime.getTime() < cutoff) {
                    fs.unlinkSync(filepath);
                    removed++;
                }
            } catch (e) {
                // Best effort
            }
        }
        
        return removed;
    }
}

module.exports = CandidateStore;