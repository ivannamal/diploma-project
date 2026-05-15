const express = require('express');
const ctrl = require('../controllers/fix.controller');

const router = express.Router();

router.post('/issues/:issueId/apply-fix', ctrl.applyFix);
router.post('/issues/:issueId/ignore', ctrl.ignore);

module.exports = router;
