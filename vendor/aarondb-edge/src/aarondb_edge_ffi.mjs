export function phash2(data) {
    let s = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

export function byte_size(bits) {
    return bits.buffer.byteLength;
}

export function cosine_similarity(v1, v2) {
    const a = Array.isArray(v1) ? v1 : (v1.toArray ? v1.toArray() : [...v1]);
    const b = Array.isArray(v2) ? v2 : (v2.toArray ? v2.toArray() : [...v2]);

    let dotProduct = 0;
    let mA = 0;
    let mB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += (a[i] * b[i]);
        mA += (a[i] * a[i]);
        mB += (b[i] * b[i]);
    }
    mA = Math.sqrt(mA);
    mB = Math.sqrt(mB);
    const result = dotProduct / (mA * mB);
    return isNaN(result) ? 0 : result;
}
